const Bull = require('bull')
const config = require('./config')
const { logger: genericLogger } = require('./logging')

const PROCESS_NAMES = Object.freeze({
  rehydrate_dir: 'rehydrate_dir',
  rehydrate_file: 'rehydrate_file'
})
const MAX_CONCURRENCY = config.get('rehydrateMaxConcurrency')
const MAX_COUNT = 50000

class RehydrateIpfsQueue {
  constructor () {
    this.queue = new Bull(
      'rehydrateIpfs',
      {
        redis: {
          host: config.get('redisHost'),
          port: config.get('redisPort')
        }
      }
    )

    // Most errors in the rehydrate calls will be caught; this try/catch is to catch unexpected errors
    this.queue.process(PROCESS_NAMES.rehydrate_file, MAX_CONCURRENCY, `${__dirname}/rehydrateIpfsTasks.js`)
    this.queue.process(PROCESS_NAMES.rehydrate_dir, MAX_CONCURRENCY, `${__dirname}/rehydrateIpfsTasks.js`)

    this.addRehydrateIpfsFromFsTask = this.addRehydrateIpfsFromFsIfNecessaryTask.bind(this)
    this.addRehydrateIpfsDirFromFsIfNecessaryTask = this.addRehydrateIpfsDirFromFsIfNecessaryTask.bind(this)
  }

  async logStatus (logContext, message) {
    const logger = genericLogger.child(logContext)
    const count = await this.queue.count()
    logger.debug(`RehydrateIpfsQueue: ${message}, count: ${count}`)
  }

  async logError (logContext, message) {
    const logger = genericLogger.child(logContext)
    logger.error(`RehydrateIpfsQueue error: ${message}`)
  }

  /**
   * Adds rehydrate file task
   * @param {string} multihash
   * @param {string} storagePath
   * @param {object} logContext
   */
  async addRehydrateIpfsFromFsIfNecessaryTask (multihash, storagePath, { logContext }, filename = null) {
    this.logStatus(logContext, 'Adding a rehydrateIpfsFromFsIfNecessary task to the queue!')
    const count = await this.queue.count()
    if (count > MAX_COUNT) return
    const job = await this.queue.add(
      PROCESS_NAMES.rehydrate_file,
      { multihash, storagePath, filename, logContext }
    )
    this.logStatus(logContext, 'Successfully added a rehydrateIpfsFromFsIfNecessary task!')

    return job
  }

  /**
   * Adds rehydrate directory task
   * @param {string} multihash
   * @param {object} logContext
   */
  async addRehydrateIpfsDirFromFsIfNecessaryTask (multihash, { logContext }) {
    this.logStatus(logContext, 'Adding a rehydrateIpfsDirFromFsIfNecessary task to the queue!')
    const count = await this.queue.count()
    if (count > MAX_COUNT) return
    const job = await this.queue.add(
      PROCESS_NAMES.rehydrate_dir,
      { multihash, logContext }
    )
    this.logStatus(logContext, 'Successfully added a rehydrateIpfsDirFromFsIfNecessary task!')

    return job
  }
}

module.exports = new RehydrateIpfsQueue()
