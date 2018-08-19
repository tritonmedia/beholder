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
const logger = require('pino')({
  name: path.basename(__filename)
})

const metricsDb = dyn('redis') + '/1'
const listener = new Redis(metricsDb)
const redis = new Redis(metricsDb)

listener.subscribe('progress', err => {
  if (err) throw err
})

const init = async () => {
  const config = await Config('events')
  const trello = new Trello(config.keys.trello.key, config.keys.trello.token)

  const comment = async (job, text) => {
    logger.info('creating comment on', job, 'with text:', text)

    await trello.makeRequest('post', `/1/cards/${job}/actions/comments`, {
      text: text || 'Failed to retrieve comment text.'
    })
  }

  const events = {
    /**
     * Emit progress events
     * @param  {String}  job  Job ID
     * @param  {Object}  data Metric Object
     * @return {Promise}      ...
     */
    progress: async (job, data) => {
      const { percent, stage } = data
      const key = `job:${job}:${stage}`
      const now = moment().toISOString()
      const started = await redis.hget(key, 'started')

      const child = logger.child({
        job,
        started,
        stage,
        percent
      })

      if (stage === 'queue') return // skip error/queue events for now

      if (stage === 'error') {
        return comment(job, 'Status was set to errored.')
      }

      child.debug('processing', data)

      if (percent === 100) {
        redis.hset(key, 'finished', now)

        child.info('finished stage')

        const startedAt = moment(started)
        const fromNow = moment().diff(startedAt, 'minutes', true)

        child.info('took', fromNow)

        await comment(job, `Finished stage '${stage}' in **${fromNow} minutes**.`)
      } else if (percent === 0) {
        child.info('started stage')
        redis.hset(key, 'started', now)
      }

      redis.hset(key, 'percent', percent)
    }
  }

  listener.on('message', async (chan, msg) => {
    const data = JSON.parse(msg)
    const event = events[chan]

    if (!event) return debug('metric', chan, 'not implemented')
    await event(data.job, data)
  })

  logger.info('initialized')
}

init()
