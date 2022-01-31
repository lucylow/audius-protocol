const contractConfig = require('../contract-config.js')
const _lib = require('../utils/lib')

const AudiusAdminUpgradeabilityProxy = artifacts.require('AudiusAdminUpgradeabilityProxy')
const TrustedNotifierManager = artifacts.require('TrustedNotifierManager')
const Governance = artifacts.require('Governance')

const trustedNotifierManagerProxyKey = web3.utils.utf8ToHex('TrustedNotifierManagerProxy')

module.exports = (deployer, network, accounts) => {
  deployer.then(async () => {
    // Fetch configs
    const config = contractConfig[network]
    const proxyDeployerAddress = config.proxyDeployerAddress || accounts[11]
    const guardianAddress = config.guardianAddress || proxyDeployerAddress

    const governanceAddress = process.env.governanceAddress
    const governance = await Governance.at(governanceAddress)

    // Deploy TrustedNotifierManager logic and proxy contracts and register proxy
    const trustedNotifierManager0 = await deployer.deploy(TrustedNotifierManager, { from: proxyDeployerAddress })
    const initializeCallData = _lib.encodeCall(
      'initialize',
      ['address'],
      [governanceAddress]
    )
    const trustedNotifierManagerProxy = await deployer.deploy(
      AudiusAdminUpgradeabilityProxy,
      trustedNotifierManager0.address,
      process.env.governanceAddress,
      initializeCallData,
      { from: proxyDeployerAddress }
    )
    await _lib.registerContract(governance, trustedNotifierManagerProxyKey, trustedNotifierManagerProxy.address, guardianAddress)

    // Set environment variable
    process.env.notifierAddress = trustedNotifierManagerProxy.address
  })
}