/**
 * Beholder - metrics and event system
 *
 * @author Jared Allard <jaredallard@outlook.com>
 * @license MIT
 * @version 1
 */

const Redis = require('ioredis')
const dyn = require('triton-core/dynamics')
const Config = require('triton-core/config')
const Trello = require('trello')
const moment = require('moment')
const path = require('path')
const fs = require('fs-extra')
const logger = require('pino')({
  name: path.basename(__filename)
})

const metricsDb = dyn('redis') + '/1'
const listener = new Redis(metricsDb)
const redis = new Redis(metricsDb)

const eventTable = {}

const subs = [
  'progress',
  'error',
  'events'
]

// TODO: move this somewhere nice
// Suggested Fix: <message>
const knownErrors = {
  ERRDLSTALL: 'Try finding another source.'
}

const init = async () => {
  for (let sub of subs) {
    logger.info('listening on pubsub queue:', sub)
    await listener.subscribe(sub)
  }

  const userEvents = await fs.readdir(path.join(__dirname, 'events'))
  userEvents.forEach(event => {
    const registeredName = path.parse(event).name
    const fn = require(path.join(__dirname, 'events', event))
    if (typeof fn !== 'function') {
      logger.warn('skipping invalid event:', registeredName, 'type is:', typeof fn)
      return
    }
    eventTable[registeredName] = async function (data) {
      return fn(redis, data, {
        comment,
        logger: logger.child({
          event: registeredName
        })
      })
    }

    logger.info('registered event:', registeredName)
  })

  const config = await Config('events')
  const trello = new Trello(config.keys.trello.key, config.keys.trello.token)

  const comment = async (job, text) => {
    logger.info('creating comment on', job, 'with text:', text)

    await trello.makeRequest('post', `/1/cards/${job}/actions/comments`, {
      text: text || 'Failed to retrieve comment text.'
    })
  }

  const checkDownloadStatus = async () => {
    const downloads = await redis.keys('job:*:download')
    for (let key of downloads) {
      const keySplit = key.split(':')
      const jobID = keySplit[1]

      logger.info('checking download status for', key, `(job: ${jobID})`)

      const percentBefore = await redis.hget(key, 'percent')
      const percent = parseInt(percentBefore, 10)

      if (percent === 100 || percent === 0) {
        logger.info(`clearning up old download at ${percent}`)
        await redis.del(key)
        continue
      }

      // calc eta
      const started = await redis.hget(key, 'started')
      const startedAt = moment(started)
      const fromNow = moment().diff(startedAt, 'minutes', true)
      // mins eclapsed / total percent * remainder percent
      const etaMins = Math.floor((fromNow / percent) * (100 - percent))
      const dur = moment.duration(etaMins, 'minutes')

      await comment(jobID, `download: progress **${Math.floor(percent)}%** (eta: ${dur.humanize()})`)
    }
  }

  // every 5 minutes
  setInterval(checkDownloadStatus, 60000 * 10)

  checkDownloadStatus()

  logger.info('started download watcher')

  const events = {
    /**
     * Emit progress events
     * @param  {String}  job  Job ID
     * @param  {Object}  data Metric Object
     * @return {Promise}      ...
     */
    progress: async (job, data) => {
      const { percent, stage, host } = data
      const key = `job:${job}:${stage}`
      const now = moment().toISOString()
      const started = await redis.hget(key, 'started')

      if (!data.data) {
        data.data = {
          subTask: 0,
          subTasks: 0
        }
      }

      const { subTask, subTasks } = data.data

      const child = logger.child({
        job,
        started,
        stage,
        percent,
        subTask,
        subTasks
      })

      if (stage === 'queue') return // skip error/queue events for now
      if (stage === 'error') return // this is handled by the 'error' metric now.

      child.debug('processing', data)

      if (percent === 100 && subTask === subTasks) {
        redis.hset(key, 'finished', now)

        child.info('finished stage')

        const startedAt = moment(started)
        const fromNow = moment().diff(startedAt, 'minutes', true)

        child.info('took', fromNow)

        await comment(job, `Finished stage '${stage}' in **${fromNow} minutes**.`)
      } else if (percent === 0 && subTask === subTasks) {
        child.info('started stage on', host)
        redis.hset(key, 'started', now)
        await comment(job, `Started stage **${stage}** on _${host}_`)
      } else if (percent === 0 && subTasks) {
        child.info('started sub-task')
        redis.hset(`${key}:${subTask}`, 'started', now)
      } else if (percent === 100 && subTask) {
        child.info('finished subTask')

        const started = await redis.hget(`${key}:${subTask}`, 'started')
        const startedAt = moment(started)
        const fromNow = moment().diff(startedAt, 'minutes', true)

        await comment(job, `${stage}: Finished sub-task **${subTask}** out of **${subTasks}** in **${fromNow} minutes**`)

        if (subTask === 1) {
          await comment(job, `${stage}: Estimating completion in **${fromNow * subTasks} minutes**`)
        }

        redis.hset(`${key}:${subTask}`, 'finished', now)
      }

      redis.hset(key, 'percent', percent)
    },

    /**
     * Process reported errors
     * @param {Object} job jobID
     * @param {Object} err Error object
     */
    error: async (job, err) => {
      const { stage, data } = err

      await comment(job, `${stage}: Failed: ${data.message}`)

      const potentialFix = knownErrors[data.code]
      if (potentialFix) {
        await comment(job, `Suggested fix: ${potentialFix}`)
      }
    },

    /**
     * Process reported events. Will one day replace the process system
     *
     * @param {Object} e event object to process
     */
    events: async e => {
      const { event, cause } = e
      logger.info('got event', event)
      if (!eventTable) {
        return logger.warn('skipping event we dont know of:', event)
      }

      eventTable[event](cause)
    }
  }

  listener.on('message', async (chan, msg) => {
    let data
    try {
      data = JSON.parse(msg)
    } catch (err) {
      logger.error('Failed to parse msg:', err)
      return
    }

    const event = events[chan]

    if (!event) return logger.warn('metric', chan, 'not implemented')
    if (data.job) {
      await event(data.job, data)
    } else {
      await event(data)
    }
  })

  logger.info('initialized')
}

init()
