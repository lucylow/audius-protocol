import { DecisionTreeStage, ServiceSelector } from "../../ServiceSelector";

const {
  DISCOVERY_SERVICE_NAME,
  UNHEALTHY_BLOCK_DIFF,
  REGRESSED_MODE_TIMEOUT,
} = require("./constants");
const semver = require("semver");

const PREVIOUS_VERSIONS_TO_CHECK = 5;

export class DiscoveryProviderSelector extends ServiceSelector {
  private currentVersion: string;
  private ethContracts: unknown;
  private selectionCallback: (
    endpoint: string,
    decisionTree: Array<DecisionTreeStage>
  ) => void;
  /**
   * Callbacks to be invoked with metrics from requests sent to a service
   */
  private monitoringCallbacks: {
    request: (args: any) => void;
    healthCheck: (args: any) => void;
  };
  private unhealthySlotDiffPlays: number;

  /**
   * Whether or not we are running in `regressed` mode, meaning we were
   * unable to select a discovery provider that was up-to-date. Clients may
   * want to consider blocking writes.
   */
  private regressedMode: boolean;

  /**
   * List of valid past discovery provider versions registered on chain
   */
  private validVersions: string[];

  constructor(config, ethContracts: unknown) {
    super({
      /**
       * Gets the "current" expected service version as well as
       * the list of registered providers from chain
       */
      getServices: async () => {
        this.currentVersion = await ethContracts.getCurrentVersion(
          DISCOVERY_SERVICE_NAME
        );
        const services = await ethContracts.getServiceProviderList(
          DISCOVERY_SERVICE_NAME
        );
        return services.map((e) => e.endpoint);
      },
      ...config,
    });
    this.ethContracts = ethContracts;
    this.currentVersion = null;
    this.selectionCallback = config.selectionCallback;
    this.monitoringCallbacks = config.monitoringCallbacks || {};
    this.unhealthySlotDiffPlays = config.unhealthySlotDiffPlays;

    this.regressedMode = false;

    this.validVersions = null;
  }

  async select() {
    const endpoint = await super.select();
    console.info(`Selected discprov ${endpoint}`, this.decisionTree);
    if (this.selectionCallback) {
      this.selectionCallback(endpoint, this.decisionTree);
    }
    return endpoint;
  }

  /**
   * Checks whether a given response is healthy:
   * - Not behind in blocks
   * - 200 response
   * - Current version
   *
   * Other responses are collected in `this.backups` if
   * - Behind by only a patch version
   *
   * @param {Response} response axios response
   * @param {{ [key: string]: string}} urlMap health check urls mapped to their cannonical url
   * e.g. https://discoveryprovider.audius.co/health_check => https://discoveryprovider.audius.co
   */
  isHealthy(response, urlMap) {
    const { status, data } = response;
    const { block_difference: blockDiff, service, version, plays } = data.data;
    let slotDiffPlays = null;
    if (plays && plays.tx_info) {
      slotDiffPlays = plays.tx_info.slot_diff;
    }

    if (this.monitoringCallbacks.healthCheck) {
      const url = new URL(response.config.url);
      try {
        this.monitoringCallbacks.healthCheck({
          endpoint: url.origin,
          pathname: url.pathname,
          queryString: url.search,
          version,
          git: data.data.git,
          blockDifference: blockDiff,
          slotDifferencePlays: slotDiffPlays,
          databaseBlockNumber: data.data.db.number,
          webBlockNumber: data.data.web.blocknumber,
          databaseSize: data.data.database_size,
          databaseConnections: data.data.database_connections,
          totalMemory: data.data.total_memory,
          usedMemory: data.data.used_memory,
          totalStorage: data.data.filesystem_size,
          usedStorage: data.data.filesystem_used,
          receivedBytesPerSec: data.received_bytes_per_sec,
          transferredBytesPerSec: data.transferred_bytes_per_sec,
          challengeLastEventAgeSec: data.challenge_last_event_age_sec,
        });
      } catch (e) {
        // Swallow errors -- this method should not throw generally
        console.error(e);
      }
    }

    if (status !== 200) return false;
    if (service !== DISCOVERY_SERVICE_NAME) return false;
    if (!semver.valid(version)) return false;

    // If this service is not the same major/minor as what's on chain, reject
    if (
      !this.ethContracts.hasSameMajorAndMinorVersion(
        this.currentVersion,
        version
      )
    ) {
      return false;
    }

    // If this service is behind by patches, add it as a backup and reject
    if (semver.patch(version) < semver.patch(this.currentVersion)) {
      this.addBackup(urlMap[response.config.url], data.data);
      return false;
    }

    // If this service is an unhealthy block diff behind, add it as a backup and reject
    if (blockDiff > UNHEALTHY_BLOCK_DIFF) {
      this.addBackup(urlMap[response.config.url], data.data);
      return false;
    }

    // If this service is an unhealthy slot diff behind on the plays table, add it
    // as a backup and reject
    if (
      slotDiffPlays !== null &&
      this.unhealthySlotDiffPlays !== null &&
      slotDiffPlays > this.unhealthySlotDiffPlays
    ) {
      this.addBackup(urlMap[response.config.url], data.data);
      return false;
    }

    return true;
  }

  /**
   * Estabilishes that connection to discovery providers has regressed
   */
  enterRegressedMode() {
    console.info("Entering regressed mode");
    this.regressedMode = true;
    setTimeout(() => {
      console.info("Leaving regressed mode");
      this.regressedMode = false;
    }, REGRESSED_MODE_TIMEOUT);
  }

  isInRegressedMode() {
    return this.regressedMode;
  }

  /**
   * In the case of no "healthy" services, we resort to backups in the following order:
   * 1. Pick the most recent (patch) version that's not behind
   * 2. Pick the least behind provider that is a valid patch version and enter "regressed mode"
   * 3. Pick `null`
   */
  async selectFromBackups() {
    const versions = [];
    const blockDiffs = [];

    const versionMap = {};
    const blockDiffMap = {};

    // Go backwards in time on chain and get the registered versions up to PREVIOUS_VERSIONS_TO_CHECK.
    // Record those versions in a set and validate any backups against that set.
    // TODO: Clean up this logic when we can validate a specific version rather
    // than traversing backwards through all the versions
    if (!this.validVersions) {
      this.validVersions = [this.currentVersion];
      const numberOfVersions = await this.ethContracts.getNumberOfVersions(
        DISCOVERY_SERVICE_NAME
      );
      for (
        let i = 0;
        i < Math.min(PREVIOUS_VERSIONS_TO_CHECK, numberOfVersions - 1);
        ++i
      ) {
        const pastServiceVersion = await this.ethContracts.getVersion(
          DISCOVERY_SERVICE_NAME,
          // Exclude the latest version when querying older versions
          // Latest index is numberOfVersions - 1, so 2nd oldest version starts at numberOfVersions - 2
          numberOfVersions - 2 - i
        );
        this.validVersions.push(pastServiceVersion);
      }
    }

    // Go through each backup and create two keyed maps:
    // { semver => [provider] }
    // { blockdiff => [provider] }
    Object.keys(this.backups).forEach((backup) => {
      const { block_difference: blockDiff, version } = this.backups[backup];

      let isVersionOk = false;
      for (let i = 0; i < this.validVersions.length; ++i) {
        if (
          this.ethContracts.hasSameMajorAndMinorVersion(
            this.validVersions[i],
            version
          )
        ) {
          isVersionOk = true;
          break;
        }
      }
      // Filter out any version that wasn't valid given what's registered on chain
      if (!isVersionOk) return;

      versions.push(version);
      blockDiffs.push(blockDiff);

      if (version in versionMap) {
        versionMap[version].push(backup);
      } else {
        versionMap[version] = [backup];
      }

      if (blockDiff in blockDiffMap) {
        blockDiffMap[blockDiff].push(backup);
      } else {
        blockDiffMap[blockDiff] = [backup];
      }
    });

    // Sort the versions by desc semver
    const sortedVersions = versions.sort(semver.rcompare);

    // Select the closest version that's a healthy # of blocks behind
    let selected = null;
    for (const version of sortedVersions) {
      const endpoints = versionMap[version];
      for (let i = 0; i < endpoints.length; ++i) {
        if (
          this.backups[endpoints[i]].block_difference < UNHEALTHY_BLOCK_DIFF
        ) {
          selected = endpoints[i];
          break;
        }
      }
      if (selected) return selected;
    }

    // Select the best block diff provider
    const bestBlockDiff = blockDiffs.sort()[0];

    selected = blockDiffMap[bestBlockDiff][0];
    this.enterRegressedMode();

    return selected;
  }
}