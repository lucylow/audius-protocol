const { recoverPersonalSignature } = require('eth-sig-util')
const fs = require('fs')
const { BufferListStream } = require('bl')

const models = require('./models')

class Utils {
  static verifySignature (data, sig) {
    return recoverPersonalSignature({ data, sig })
  }

  static async timeout (ms) {
    console.log(`starting timeout of ${ms}`)
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  static formatBytes (bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes'

    const k = 1024
    const dm = decimals < 0 ? 0 : decimals
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']

    const i = Math.floor(Math.log(bytes) / Math.log(k))

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
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
const ipfsSingleByteCat = (path, req, timeout = 1000) => new Promise(async (resolve, reject) => {
  const start = Date.now()
  let ipfs = req.app.get('ipfsLatestAPI')

  try {
    // ipfs.cat() returns an AsyncIterator<Buffer> and its results are iterated over in a for-loop
    // don't keep track of the results as this call is a proof-of-concept that the file exists in ipfs
    /* eslint-disable-next-line no-unused-vars */
    for await (const chunk of ipfs.cat(path, { length: 1, timeout })) {
      continue
    }
    req.logger.debug(`ipfsSingleByteCat - Retrieved ${path} in ${Date.now() - start}ms`)
    resolve()
  } catch (e) {
    req.logger.error(`ipfsSingleByteCat - Error: ${e}`)
    reject(e)
  }
})

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

async function rehydrateIpfsFromFsIfNecessary (req, multihash, storagePath, filename = null) {
  let ipfs = req.app.get('ipfsAPI')
  let ipfsPath = multihash
  if (filename != null) {
    // Indicates we are retrieving a directory multihash
    ipfsPath = `${multihash}/${filename}`
  }

  let rehydrateNecessary = false
  try {
    await ipfsSingleByteCat(ipfsPath, req)
  } catch (e) {
    // Do not attempt to rehydrate as file, if cat() indicates CID is of a dir.
    if (e.message.includes('this dag node is a directory')) {
      throw new Error(e.message)
    }
    rehydrateNecessary = true
    req.logger.info(`rehydrateIpfsFromFsIfNecessary - error condition met ${ipfsPath}, ${e}`)
  }
  if (!rehydrateNecessary) return
  // Timed out, must re-add from FS
  if (!filename) {
    req.logger.info(`rehydrateIpfsFromFsIfNecessary - Re-adding file - ${multihash}, stg path: ${storagePath}`)
    try {
      if (fs.existsSync(storagePath)) {
        let addResp = await ipfs.addFromFs(storagePath, { pin: false })
        req.logger.info(`rehydrateIpfsFromFsIfNecessary - Re-added file - ${multihash}, stg path: ${storagePath},  ${JSON.stringify(addResp)}`)
      } else {
        req.logger.info(`rehydrateIpfsFromFsIfNecessary - Failed to find on disk, file - ${multihash}, stg path: ${storagePath}`)
      }
    } catch (e) {
      req.logger.error(`rehydrateIpfsFromFsIfNecessary - failed to addFromFs ${e}, Re-adding file - ${multihash}, stg path: ${storagePath}`)
    }
  } else {
    req.logger.info(`rehydrateIpfsFromFsIfNecessary - Re-adding dir ${multihash}, stg path: ${storagePath}, filename: ${filename}, ipfsPath: ${ipfsPath}`)
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
        req.logger.info(`rehydrateIpfsFromFsIfNecessary - ERROR BUILDING IPFS ADD ARRAY ${e}, ${entry}`)
      }
    }

    try {
      let addResp = await ipfs.add(ipfsAddArray, { pin: false })
      req.logger.info(`rehydrateIpfsFromFsIfNecessary - addResp ${JSON.stringify(addResp)}`)
    } catch (e) {
      req.logger.error(`rehydrateIpfsFromFsIfNecessary - addResp ${e}, ${ipfsAddArray}`)
    }
  }
}

async function rehydrateIpfsDirFromFsIfNecessary (req, dirHash) {
  req.logger.info(`rehydrateIpfsDirFromFsIfNecessary, dirHash: ${dirHash}`)
  let findOriginalFileQuery = await models.File.findAll({
    where: {
      dirMultihash: dirHash,
      type: 'image'
    }
  })

  let rehydrateNecessary = false
  for (let entry of findOriginalFileQuery) {
    let filename = entry.fileName
    let ipfsPath = `${dirHash}/${filename}`
    req.logger.info(`rehydrateIpfsDirFromFsIfNecessary, ipfsPath: ${ipfsPath}`)
    try {
      await ipfsSingleByteCat(ipfsPath, req)
    } catch (e) {
      rehydrateNecessary = true
      req.logger.info(`rehydrateIpfsDirFromFsIfNecessary - error condition met ${ipfsPath}, ${e}`)
      break
    }
  }

  req.logger.info(`rehydrateIpfsDirFromFsIfNecessary, dir=${dirHash} - required = ${rehydrateNecessary}`)
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
      req.logger.info(`rehydrateIpfsDirFromFsIfNecessary - ERROR BUILDING IPFS ADD ARRAY ${e}, ${entry}`)
    }
  }
  let ipfs = req.app.get('ipfsAPI')
  try {
    let addResp = await ipfs.add(ipfsAddArray, { pin: false })
    req.logger.info(`rehydrateIpfsDirFromFsIfNecessary - ${JSON.stringify(addResp)}`)
  } catch (e) {
    req.logger.info(`rehydrateIpfsDirFromFsIfNecessary - ERROR ADDING DIR TO IPFS ${e}, ${ipfsAddArray}`)
  }
}

module.exports = Utils
module.exports.getFileUUIDForImageCID = getFileUUIDForImageCID
module.exports.getIPFSPeerId = getIPFSPeerId
module.exports.rehydrateIpfsFromFsIfNecessary = rehydrateIpfsFromFsIfNecessary
module.exports.rehydrateIpfsDirFromFsIfNecessary = rehydrateIpfsDirFromFsIfNecessary
module.exports.ipfsSingleByteCat = ipfsSingleByteCat
module.exports.ipfsCat = ipfsCat
module.exports.ipfsGet = ipfsGet
