const { recoverPersonalSignature } = require('eth-sig-util')
const fs = require('fs')
const { BufferListStream } = require('bl')
const axios = require('axios')

const { logger: genericLogger } = require('./logging')
const models = require('./models')
const { ipfs, ipfsLatest } = require('./ipfsClient')
const redis = require('./redis')

const config = require('./config')
const BlacklistManager = require('./blacklistManager')
const { generateTimestampAndSignature } = require('./apiSigning')

class Utils {
  static verifySignature (data, sig) {
    return recoverPersonalSignature({ data, sig })
  }

  static async timeout (ms) {
    console.log(`starting timeout of ${ms}`)
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

async function getFileUUIDForImageCID (req, imageCID) {
  const ipfs = req.app.get('ipfsAPI')
  if (imageCID) { // assumes imageCIDs are optional params
    // Ensure CID points to a dir, not file
    let cidIsFile = false
    try {
      await ipfs.cat(imageCID, { length: 1 })
      cidIsFile = true
    } catch (e) {
      // Ensure file exists for dirCID
      const dirFile = await models.File.findOne({
        where: { multihash: imageCID, cnodeUserUUID: req.session.cnodeUserUUID, type: 'dir' }
      })
      if (!dirFile) {
        throw new Error(`No file stored in DB for dir CID ${imageCID}`)
      }

      // Ensure file refs exist in DB for every file in dir
      const dirContents = await ipfs.ls(imageCID)
      req.logger.info(dirContents)

      // Iterates through directory contents but returns upon first iteration
      // TODO: refactor to remove for-loop
      for (let fileObj of dirContents) {
        if (!fileObj.hasOwnProperty('hash') || !fileObj.hash) {
          throw new Error(`Malformatted dir contents for dirCID ${imageCID}. Cannot process.`)
        }

        const imageFile = await models.File.findOne({
          where: { multihash: fileObj.hash, cnodeUserUUID: req.session.cnodeUserUUID, type: 'image' }
        })
        if (!imageFile) {
          throw new Error(`No file ref stored in DB for CID ${fileObj.hash} in dirCID ${imageCID}`)
        }
        return dirFile.fileUUID
      }
    }
    if (cidIsFile) {
      throw new Error(`CID ${imageCID} must point to a valid directory on IPFS`)
    }
  } else return null
}

async function getIPFSPeerId (ipfs, config) {
  const ipfsClusterIP = config.get('ipfsClusterIP')
  const ipfsClusterPort = config.get('ipfsClusterPort')

  let ipfsIDObj = await ipfs.id()

  // if it's a real host and port, generate a new ipfs id and override the addresses with this value
  // if it's local or these variables aren't passed in, just return the regular ipfs.id() result
  if (ipfsClusterIP && ipfsClusterPort !== null && ipfsClusterIP !== '127.0.0.1' && ipfsClusterPort !== 0) {
    const addressStr = `/ip4/${ipfsClusterIP}/tcp/${ipfsClusterPort}/ipfs/${ipfsIDObj.id}`
    ipfsIDObj.addresses = [addressStr]
  }

  return ipfsIDObj
}

/**
 * Cat single byte of file at given filepath. If ipfs.cat() call takes longer than the timeout time or
 * something goes wrong, an error will be thrown.
*/
const ipfsSingleByteCat = (path, logContext, timeout = 1000) => {
  const logger = genericLogger.child(logContext)

  return new Promise(async (resolve, reject) => {
    const start = Date.now()

    try {
      // ipfs.cat() returns an AsyncIterator<Buffer> and its results are iterated over in a for-loop
      // don't keep track of the results as this call is a proof-of-concept that the file exists in ipfs
      /* eslint-disable-next-line no-unused-vars */
      for await (const chunk of ipfsLatest.cat(path, { length: 1, timeout })) {
        continue
      }
      logger.info(`ipfsSingleByteCat - Retrieved ${path} in ${Date.now() - start}ms`)
      resolve()
    } catch (e) {
      // Expected message for e is `TimeoutError: Request timed out`
      // if it's not that message, log out the error
      if (!e.message.includes('Request timed out')) {
        logger.error(`ipfsSingleByteCat - Error: ${e}`)
      }
      reject(e)
    }
  })
}

/**
 * Stat of a file at given filepath. If ipfs.files.stat() call takes longer than the timeout time or
 * something goes wrong, an error will be thrown.
*/
const ipfsStat = (CID, logContext, timeout = 1000) => {
  const logger = genericLogger.child(logContext)

  return new Promise(async (resolve, reject) => {
    const start = Date.now()
    const timeoutRef = setTimeout(() => {
      logger.error(`ipfsStat - Timeout`)
      reject(new Error('IPFS Stat Timeout'))
    }, timeout)

    try {
      const stats = await ipfsLatest.files.stat(`/ipfs/${CID}`)
      logger.info(`ipfsStat - Retrieved ${CID} in ${Date.now() - start}ms`)
      clearTimeout(timeoutRef)
      resolve(stats)
    } catch (e) {
      logger.error(`ipfsStat - Error: ${e}`)
      reject(e)
    }
  })
}

/**
 * Call ipfs.cat on a path with optional timeout and length parameters
 * @param {*} path IPFS cid for file
 * @param {*} req request object
 * @param {*} timeout timeout for IPFS op in ms
 * @param {*} length length of data to retrieve from file
 * @returns {Buffer}
 */
const ipfsCat = (path, req, timeout = 1000, length = null) => new Promise(async (resolve, reject) => {
  const start = Date.now()
  let ipfs = req.app.get('ipfsLatestAPI')

  try {
    let chunks = []
    let options = {}
    if (length) options.length = length
    if (timeout) options.timeout = timeout
    // ipfs.cat() returns an AsyncIterator<Buffer> and its results are iterated over in a for-loop
    /* eslint-disable-next-line no-unused-vars */
    for await (const chunk of ipfs.cat(path, options)) {
      chunks.push(chunk)
    }
    req.logger.debug(`ipfsCat - Retrieved ${path} in ${Date.now() - start}ms`)
    resolve(Buffer.concat(chunks))
  } catch (e) {
    req.logger.error(`ipfsCat - Error: ${e}`)
    reject(e)
  }
})

/**
 * Call ipfs.get on a path with an optional timeout
 * @param {String} path IPFS cid for file
 * @param {Object} req request object
 * @param {Number} timeout timeout in ms
 * @returns {BufferListStream}
 */
const ipfsGet = (path, req, timeout = 1000) => new Promise(async (resolve, reject) => {
  const start = Date.now()
  let ipfs = req.app.get('ipfsLatestAPI')

  try {
    let chunks = []
    let options = {}
    if (timeout) options.timeout = timeout
    // ipfs.get() returns an AsyncIterator<Buffer> and its results are iterated over in a for-loop
    /* eslint-disable-next-line no-unused-vars */
    for await (const file of ipfs.get(path, options)) {
      if (!file.content) continue

      const content = new BufferListStream()
      for await (const chunk of file.content) {
        content.append(chunk)
      }
      resolve(content)
    }
    req.logger.info(`ipfsGet - Retrieved ${path} in ${Date.now() - start}ms`)
    resolve(Buffer.concat(chunks))
  } catch (e) {
    req.logger.error(`ipfsGet - Error: ${e}`)
    reject(e)
  }
})

async function findCIDInNetwork (filePath, cid, logger, libs) {
  const attemptedStateFix = await getIfAttemptedStateFix(filePath)
  if (attemptedStateFix) return

  // get list of creator nodes
  const creatorNodes = await getAllRegisteredCNodes(libs)
  if (!creatorNodes.length) return

  // generate signature
  const delegateWallet = config.get('delegateOwnerWallet').toLowerCase()
  const { signature, timestamp } = generateTimestampAndSignature({ filePath, delegateWallet }, config.get('delegatePrivateKey'))
  let node

  for (let index = 0; index < creatorNodes.length; index++) {
    node = creatorNodes[index]
    try {
      const resp = await axios({
        method: 'get',
        url: `${node.endpoint}/file_lookup`,
        params: {
          filePath,
          timestamp,
          delegateWallet,
          signature
        },
        responseType: 'stream',
        timeout: 1000
      })
      if (resp.data) {
        await writeStreamToFileSystem(resp.data, filePath)

        // verify that the file written matches the hash expected if added to ipfs
        const content = fs.createReadStream(filePath)
        for await (const result of ipfsLatest.add(content, { onlyHash: true, timeout: 2000 })) {
          if (cid !== result.cid.toString()) {
            await fs.unlink(filePath)
            logger.error(`File contents don't match IPFS hash cid: ${cid} result: ${result.cid.toString()}`)
          }
        }

        logger.info(`findCIDInNetwork - successfully fetched file ${filePath} from node ${node.endpoint}`)
        break
      }
    } catch (e) {
      // since this is a function running in the background intended to fix state, don't error
      // and stop the flow of execution for functions that call it
      continue
    }
  }
}

/**
 * Get all creator nodes registered on chain from a cached redis value
 */
async function getAllRegisteredCNodes (libs) {
  const cacheKey = 'all_registered_cnodes'

  try {
    const cnodesList = await redis.get(cacheKey)
    if (cnodesList) {
      return JSON.parse(cnodesList)
    }

    let creatorNodes = (await libs.ethContracts.ServiceProviderFactoryClient.getServiceProviderList('creator-node'))
    creatorNodes = creatorNodes.filter(node => node.endpoint !== config.get('creatorNodeEndpoint'))
    redis.set(cacheKey, JSON.stringify(creatorNodes), 'EX', 60 * 30) // cache this for 30 minutes
    return creatorNodes
  } catch (e) {
    console.error('Error getting values in getAllRegisteredCNodes', e)
  }
  return []
}

/**
 * Return if a fix has already been attempted in today for this filePath
 * @param {String} filePath path of CID on the file system
 */
async function getIfAttemptedStateFix (filePath) {
  // key is `attempted_fs_fixes:<today's date>`
  // the date function just generates the ISOString and removes the timestamp component
  const key = `attempted_fs_fixes:${new Date().toISOString().split('T')[0]}`
  const firstTime = await redis.sadd(key, filePath)
  await redis.expire(key, 60 * 60 * 24) // expire one day after final write

  // if firstTime is 1, it's a new key. existing key returns 0
  return !firstTime
}

async function rehydrateIpfsFromFsIfNecessary (multihash, storagePath, logContext, filename = null) {
  const logger = genericLogger.child(logContext)

  if (await BlacklistManager.CIDIsInBlacklist(multihash)) {
    logger.info(`rehydrateIpfsFromFsIfNecessary - CID ${multihash} is in blacklist; Skipping rehydrate.`)
    return
  }

  let ipfsPath = multihash
  if (filename != null) {
    // Indicates we are retrieving a directory multihash
    ipfsPath = `${multihash}/${filename}`
  }

  let rehydrateNecessary = false
  try {
    await ipfsSingleByteCat(ipfsPath, logContext)
  } catch (e) {
    // Do not attempt to rehydrate as file, if cat() indicates CID is of a dir.
    if (e.message.includes('this dag node is a directory')) {
      throw new Error(e.message)
    }
    rehydrateNecessary = true
    logger.info(`rehydrateIpfsFromFsIfNecessary - error condition met ${ipfsPath}, ${e}`)
  }
  if (!rehydrateNecessary) return
  // Timed out, must re-add from FS
  if (!filename) {
    logger.info(`rehydrateIpfsFromFsIfNecessary - Re-adding file - ${multihash}, stg path: ${storagePath}`)
    try {
      if (fs.existsSync(storagePath)) {
        let addResp = await ipfs.addFromFs(storagePath, { pin: false })
        logger.info(`rehydrateIpfsFromFsIfNecessary - Re-added file - ${multihash}, stg path: ${storagePath},  ${JSON.stringify(addResp)}`)
      } else {
        logger.info(`rehydrateIpfsFromFsIfNecessary - Failed to find on disk, file - ${multihash}, stg path: ${storagePath}`)
      }
    } catch (e) {
      logger.error(`rehydrateIpfsFromFsIfNecessary - failed to addFromFs ${e}, Re-adding file - ${multihash}, stg path: ${storagePath}`)
    }
  } else {
    logger.info(`rehydrateIpfsFromFsIfNecessary - Re-adding dir ${multihash}, stg path: ${storagePath}, filename: ${filename}, ipfsPath: ${ipfsPath}`)
    let findOriginalFileQuery = await models.File.findAll({
      where: {
        dirMultihash: multihash,
        type: 'image'
      }
    })
    // Add entire directory to recreate original operation
    // Required to ensure same dirCID as data store
    let ipfsAddArray = []
    for (var entry of findOriginalFileQuery) {
      let sourceFilePath = entry.storagePath
      try {
        let bufferedFile = fs.readFileSync(sourceFilePath)
        let originalSource = entry.sourceFile
        ipfsAddArray.push({
          path: originalSource,
          content: bufferedFile
        })
      } catch (e) {
        logger.info(`rehydrateIpfsFromFsIfNecessary - ERROR BUILDING IPFS ADD ARRAY ${e}, ${entry}`)
      }
    }

    try {
      let addResp = await ipfsLatest.add(ipfsAddArray, { pin: false })
      logger.info(`rehydrateIpfsFromFsIfNecessary - addResp ${JSON.stringify(addResp)}`)
    } catch (e) {
      logger.error(`rehydrateIpfsFromFsIfNecessary - addResp ${e}, ${ipfsAddArray}`)
    }
  }
}

async function rehydrateIpfsDirFromFsIfNecessary (dirHash, logContext) {
  const logger = genericLogger.child(logContext)

  if (await BlacklistManager.CIDIsInBlacklist(dirHash)) {
    logger.info(`rehydrateIpfsFromFsIfNecessary - CID ${dirHash} is in blacklist; Skipping rehydrate.`)
    return
  }

  let findOriginalFileQuery = await models.File.findAll({
    where: {
      dirMultihash: dirHash,
      type: 'image'
    }
  })

  let rehydrateNecessary = false
  for (let entry of findOriginalFileQuery) {
    const filename = entry.fileName
    let ipfsPath = `${dirHash}/${filename}`
    logger.info(`rehydrateIpfsDirFromFsIfNecessary, ipfsPath: ${ipfsPath}`)
    try {
      await ipfsSingleByteCat(ipfsPath, logContext)
    } catch (e) {
      rehydrateNecessary = true
      logger.info(`rehydrateIpfsDirFromFsIfNecessary - error condition met ${ipfsPath}, ${e}`)
      break
    }
  }

  logger.info(`rehydrateIpfsDirFromFsIfNecessary, dir=${dirHash} - required = ${rehydrateNecessary}`)
  if (!rehydrateNecessary) return

  // Add entire directory to recreate original operation
  // Required to ensure same dirCID as data store
  let ipfsAddArray = []
  for (let entry of findOriginalFileQuery) {
    let sourceFilePath = entry.storagePath
    try {
      let bufferedFile = fs.readFileSync(sourceFilePath)
      let originalSource = entry.sourceFile
      ipfsAddArray.push({
        path: originalSource,
        content: bufferedFile
      })
    } catch (e) {
      logger.info(`rehydrateIpfsDirFromFsIfNecessary - ERROR BUILDING IPFS ADD ARRAY ${e}, ${entry}`)
    }
  }
  try {
    let addResp = await ipfs.add(ipfsAddArray, { pin: false })
    logger.info(`rehydrateIpfsDirFromFsIfNecessary - ${JSON.stringify(addResp)}`)
  } catch (e) {
    logger.info(`rehydrateIpfsDirFromFsIfNecessary - ERROR ADDING DIR TO IPFS ${e}, ${ipfsAddArray}`)
  }
}

async function writeStreamToFileSystem (stream, expectedStoragePath) {
  const destinationStream = fs.createWriteStream(expectedStoragePath)
  stream.pipe(destinationStream)
  return new Promise((resolve, reject) => {
    destinationStream.on('finish', () => {
      resolve()
    })
    destinationStream.on('error', err => { reject(err) })
    stream.on('error', err => { destinationStream.end(); reject(err) })
  })
}

module.exports = Utils
module.exports.getFileUUIDForImageCID = getFileUUIDForImageCID
module.exports.getIPFSPeerId = getIPFSPeerId
module.exports.rehydrateIpfsFromFsIfNecessary = rehydrateIpfsFromFsIfNecessary
module.exports.rehydrateIpfsDirFromFsIfNecessary = rehydrateIpfsDirFromFsIfNecessary
module.exports.ipfsSingleByteCat = ipfsSingleByteCat
module.exports.ipfsCat = ipfsCat
module.exports.ipfsGet = ipfsGet
module.exports.ipfsStat = ipfsStat
module.exports.writeStreamToFileSystem = writeStreamToFileSystem
module.exports.getAllRegisteredCNodes = getAllRegisteredCNodes
module.exports.findCIDInNetwork = findCIDInNetwork
