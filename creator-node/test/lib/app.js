const nodeConfig = require('../../src/config.js')
const { runMigrations, clearDatabase } = require('../../src/migrationManager')
const redisClient = require('../../src/redis')
const MonitoringQueueMock = require('./monitoringQueueMock')
const AsyncProcessingQueueMock = require('./asyncProcessingQueueMock')
const SyncQueue = require('../../src/services/sync/syncQueue')
const TrustedNotifierManager = require('../../src/services/TrustedNotifierManager.js')

// Initialize private IPFS gateway counters
redisClient.set('ipfsGatewayReqs', 0)
redisClient.set('ipfsStandaloneReqs', 0)

async function getApp (ipfsClient, libsClient, blacklistManager, ipfsLatestClient = null, setMockFn = null, spId = null) {
  // we need to clear the cache that commonjs require builds, otherwise it uses old values for imports etc
  // eg if you set a new env var, it doesn't propogate well unless you clear the cache for the config file as well
  // as all files that consume it
  clearRequireCache()

  // run all migrations before each test
  await clearDatabase()
  await runMigrations()

  if (spId) nodeConfig.set('spID', spId)

  const mockServiceRegistry = {
    ipfs: ipfsClient,
    ipfsLatest: ipfsLatestClient || ipfsClient,
    libs: libsClient,
    blacklistManager: blacklistManager,
    redis: redisClient,
    monitoringQueue: new MonitoringQueueMock(),
    asyncProcessingQueue: new AsyncProcessingQueueMock(),
    // syncQueue: new SyncQueue(nodeConfig, redisClient, ipfsClient, ipfsLatestClient || ipfsClient),
    nodeConfig
  }
  mockServiceRegistry.syncQueue = new SyncQueue(nodeConfig, redisClient, ipfsClient, ipfsLatestClient || ipfsClient, mockServiceRegistry)
  mockServiceRegistry.trustedNotifierManager = new TrustedNotifierManager(nodeConfig, libsClient)

  // Update the import to be the mocked ServiceRegistry instance
  require.cache[require.resolve('../../src/serviceRegistry')] = {
    exports: { serviceRegistry: mockServiceRegistry }
  }

  // If one needs to set mock settings, pass in a callback to set it before initializing app
  if (setMockFn) setMockFn()

  const appInfo = require('../../src/app')(8000, mockServiceRegistry)
  appInfo.mockServiceRegistry = mockServiceRegistry
  return appInfo
}

function getServiceRegistryMock (ipfsClient, libsClient, blacklistManager, ipfsLatestClient = null) {
  return {
    ipfs: ipfsClient,
    ipfsLatest: ipfsLatestClient || ipfsClient,
    libs: libsClient,
    blacklistManager: blacklistManager,
    redis: redisClient,
    monitoringQueue: new MonitoringQueueMock(),
    syncQueue: new SyncQueue(nodeConfig, redisClient, ipfsClient, ipfsLatestClient || ipfsClient),
    nodeConfig
  }
}

function clearRequireCache () {
  console.log('DELETING CACHE')
  Object.keys(require.cache).forEach(function (key) {
    // exclude src/models/index from the key deletion because it initalizes a new connection pool
    // every time and we hit a db error if we clear the cache and keep creating new pg pools
    if (key.includes('creator-node/src/') && !key.includes('creator-node/src/models/index.js')) {
      delete require.cache[key]
    }
  })
}

module.exports = { getApp, getServiceRegistryMock }
