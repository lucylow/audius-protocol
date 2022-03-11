const config = require('../config')
const { handleResponse, successResponse, errorResponseForbidden, errorResponseBadRequest } = require('../apiHelpers')
const models = require('../models')
const { QueryTypes } = require('sequelize')
const userHandleMiddleware = require('../userHandleMiddleware')
const authMiddleware = require('../authMiddleware')

module.exports = function (app) {
  app.get('/id_signals', userHandleMiddleware, handleResponse(async req => {
    if (req.headers['x-score'] !== config.get('scoreSecret')) {
      return errorResponseForbidden('Not permissioned to view scores.')
    }

    const handle = req.query.handle
    if (!handle) return errorResponseBadRequest('Please provide handle')

    const captchaScores = await models.sequelize.query(
      `select "Users"."blockchainUserId" as "userId", "BotScores"."recaptchaScore" as "score", "BotScores"."recaptchaContext" as "context", "BotScores"."updatedAt" as "updatedAt"
      from 
        "Users" inner join "BotScores" on "Users"."walletAddress" = "BotScores"."walletAddress"
      where
        "Users"."handle" = :handle`,
      {
        replacements: { handle },
        type: QueryTypes.SELECT
      }
    )

    const cognitoFlowScores = await models.sequelize.query(
      `select "Users"."blockchainUserId" as "userId", "CognitoFlows"."score" as "score"
      from 
        "Users" inner join "CognitoFlows" on "Users"."handle" = "CognitoFlows"."handle"
      where
        "Users"."handle" = :handle`,
      {
        replacements: { handle },
        type: QueryTypes.SELECT
      }
    )

    const socialHandles = await models.SocialHandles.findOne({
      where: { handle }
    })

    const twitterUser = await models.TwitterUser.findOne({
      where: {
        // Twitter stores case sensitive screen names
        'twitterProfile.screen_name': handle,
        verified: true
      }
    })

    const instagramUser = await models.InstagramUser.findOne({
      where: {
        // Instagram does not store case sensitive screen names
        'profile.username': handle.toLowerCase(),
        verified: true
      }
    })

    const userIPRecord = await models.UserIPs.findOne({ where: { handle } })
    const userIP = userIPRecord && userIPRecord.userIP

    const response = { captchaScores, cognitoFlowScores, socialSignals: {}, userIP, emailAddress: req.user.email }
    if (socialHandles) {
      response.socialSignals = {
        ...socialHandles.dataValues,
        twitterVerified: !!twitterUser,
        instagramVerified: !!instagramUser
      }
    }
    return successResponse(response)
  }))

  app.get('/record_ip', authMiddleware, handleResponse(async req => {
    const { blockchainUserId, handle } = req.user
    const userIP = req.ip
    req.logger.info(`req.ip is ${req.ip} (X-Forwarded-For: ${req.get('X-Forwarded-For')}) for user with id ${blockchainUserId} and handle ${handle}`)

    const record = await models.UserIPs.findOne({ where: { handle } })
    req.logger.info(`Record for user ${handle}: ${JSON.stringify(record)}`)
    // if (!record) {
    //   req.logger.info(`Saving IP ${userIP} for user ${handle}`)
    //   await models.UserIPs.create({
    //     handle,
    //     userIP
    //   })
    // } else {
    //   // update even if IP has not changed so that we can later use updatedAt value if necessary
    //   req.logger.info(`Updating IP ${userIP} for user ${handle}`)
    //   await record.update({ userIP })
    // }

    return successResponse({ userIP })
  }))
}
