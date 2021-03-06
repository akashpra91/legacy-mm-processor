/**
 * The service to handle new submission events.
 */
const _ = require('lodash')
const Axios = require('axios')
const util = require('util')
const config = require('config')
const Flatted = require('flatted')
const Joi = require('joi')
const logger = require('../common/logger')
const LegacySubmissionIdService = require('legacy-processor-module/LegacySubmissionIdService')
const { handleMarathonSubmission, updateReviewScore } = require('./MarathonSubmissionService')

// Custom Joi type
Joi.id = () => Joi.number().integer().positive().required()

// The event schema to validate events from Kafka
const eventSchema = Joi.object().keys({
  topic: Joi.string().required(),
  originator: Joi.string().required(),
  timestamp: Joi.date().required(),
  'mime-type': Joi.string().required(),
  payload: Joi.object().keys({
    id: Joi.alternatives().try(Joi.id(), Joi.string().uuid()).required(),
    resource: Joi.alternatives().try(Joi.string().valid('submission'), Joi.string().valid('review'), Joi.string().valid('reviewSummation')),
    challengeId: Joi.id().optional(),
    memberId: Joi.id().optional(),
    submissionPhaseId: Joi.id().optional(),
    url: Joi.string().uri().optional(),
    type: Joi.string().optional(),
    legacySubmissionId: Joi.number().integer().positive().optional(),
    isExample: Joi.number().integer().valid(0, 1).optional(),
    typeId: Joi.string().optional(),
    score: Joi.number().min(0).max(100).optional(),
    metadata: Joi.object().keys({
      testType: Joi.string().required()
    }).optional()
  }).required().unknown(true)
})


/**
 * Get the submission
 * @param {string} submissionId 
 * @returns {object} submission object
 */
async function getSubmission (submissionId, m2m) {
  try {
    const axios = Axios.create({
      baseURL: config.SUBMISSION_API_URL,
      timeout: config.SUBMISSION_TIMEOUT
    })

    // M2M token necessary for pushing to Bus API
    let apiOptions = null
    if (m2m) {
      const token = await m2m.getMachineToken(config.AUTH0_CLIENT_ID, config.AUTH0_CLIENT_SECRET)
      apiOptions = { headers: { 'Authorization': `Bearer ${token}` } }
    }

    logger.info(`Fetching submission for ${submissionId}`)
    let sub = await axios.get(`/submissions/${submissionId}`, apiOptions)
    logger.info(`Fetched submission for ${submissionId} - ${sub.data}`)

    return sub.data;
  } catch (err) {
    if (err.response) { // non-2xx response received
      logger.error(`Submission API Error: ${Flatted.stringify({
        data: err.response.data,
        status: err.response.status,
        headers: err.response.headers
      }, null, 2)}`)
    } else if (err.request) {
      logger.error(`Submission API Error (request sent, no response): ${Flatted.stringify(err.request, null, 2)}`)
    } else {
      logger.error(util.inspect(err))
    }
  }
}

/**
 * Get the subtrack for a challenge.
 * @param {string} challengeId - The id of the challenge.
 * @returns {string} The subtrack type of the challenge.
 */
async function getSubTrack (submissionId, m2m) {
  try {
    const submission = await getSubmission(submissionId, m2m);

    logger.info(`Fetching challenge details for ${submission.challengeId}`)
    // attempt to fetch the subtrack
    const result = await Axios.get(config.CHALLENGE_INFO_API.replace('{cid}', submission.challengeId))
    // use _.get to avoid access with undefined object
    return _.get(result.data, 'result.content[0].subTrack')
  } catch (err) {
    if (err.response) { // non-2xx response received
      logger.error(`Challenge Details API Error: ${Flatted.stringify({
        data: err.response.data,
        status: err.response.status,
        headers: err.response.headers
      }, null, 2)}`)
    } else if (err.request) { // request sent, no response received
      // may throw such error Converting circular structure to JSON if use native JSON.stringify
      // https://github.com/axios/axios/issues/836
      logger.error(`Challenge Details API Error (request sent, no response): ${Flatted.stringify(err.request, null, 2)}`)
    } else {
      logger.error(util.inspect(err))
    }
  }
}

/**
 * Handle new submission message.
 * @param {String} value the message value (JSON string)
 * @param {Object} db the informix database
 * @param {Object} m2m the m2m auth
 * @param {IDGenerator} idUploadGen IDGenerator instance of upload
 * @param {IDGenerator} idSubmissionGen IDGenerator instance of submission
 */
async function handle (value, db, m2m, idUploadGen, idSubmissionGen) {
  if (!value) {
    logger.debug('Skipped null or empty event')
    return
  }

  // Parse JSON string to get the event
  let event
  try {
    event = JSON.parse(value)
  } catch (err) {
    logger.debug(`Skipped non well-formed JSON message: ${err.message}`)
    return
  }

  if (!event) {
    logger.debug('Skipped null or empty event')
    return
  }

  // Validate event
  const validationResult = Joi.validate(event, eventSchema, { abortEarly: false, stripUnknown: true })
  if (validationResult.error) {
    const validationErrorMessage = _.map(validationResult.error.details, 'message').join(', ')
    logger.debug(`Skipped invalid event, reasons: ${validationErrorMessage}`)
    return
  }

  // Check topic and originator
  if (event.topic !== config.KAFKA_NEW_SUBMISSION_TOPIC && event.topic !== config.KAFKA_UPDATE_SUBMISSION_TOPIC) {
    logger.debug(`Skipped event from topic ${event.topic}`)
    return
  }

  if (event.originator !== config.KAFKA_NEW_SUBMISSION_ORIGINATOR) {
    logger.debug(`Skipped event from originator ${event.originator}`)
    return
  }

  if (event.payload.resource === 'submission') {
    logger.debug(`Skipped event from resource ${event.payload.resource}`)
    return
  }

  // attempt to retrieve the subTrack of the challenge
  const subTrack = await getSubTrack(event.payload.submissionId, m2m)
  logger.debug(`Challenge get subTrack ${subTrack}`)
  const challangeSubtracks = config.CHALLENGE_SUBTRACK.split(',').map(x => x.trim())
  if (!(subTrack && challangeSubtracks.includes(subTrack))) {
    logger.debug(`Skipping as NOT MM found in ${JSON.stringify(challangeSubtracks)}`)
    return;
  }

  // for MM Review type
  if (event.payload.resource && event.payload.resource === 'review') {
    const payloadTypes = config.PAYLOAD_TYPES.split(',').map(x => x.trim())
    if (event.payload.typeId && payloadTypes.includes(event.payload.typeId)) {
      await updateReviewScore(Axios, m2m, event, db)
    } else {
      logger.debug(`Skipped Invalid typeId`)
    }
  } else if (event.payload.resource && event.payload.resource === 'reviewSummation') {
    if (event.topic === config.KAFKA_NEW_SUBMISSION_TOPIC) {
      let reviewScore = _.get(event, 'payload.aggregateScore')
      let submissionId = _.get(event, 'payload.submissionId')

      let sub = await getSubmission(submissionId, m2m);
      if (!sub.legacySubmissionId) {
        throw new Error(`legacySubmissionId not found`)
      }

      await LegacySubmissionIdService.updateReviewScore(db, sub.legacySubmissionId, reviewScore, 'finalScore')
    }
  } 
}

module.exports = {
  handle
}
