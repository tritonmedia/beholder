/**
 * Beholder - metrics and event system
 *
 * @author Jared Allard <jaredallard@outlook.com>
 * @license MIT
 * @version 1
 */

const Trello = require('trello')
const path = require('path')
const logger = require('pino')({
  name: path.basename(__filename)
})

const dyn = require('triton-core/dynamics')
const Config = require('triton-core/config')
const AMQP = require('triton-core/amqp')
const Storage = require('triton-core/db')
const proto = require('triton-core/proto')

const init = async () => {
  const config = await Config('events')
  const trello = new Trello(config.keys.trello.key, config.keys.trello.token)

  const db = new Storage()
  const amqp = new AMQP(dyn('rabbitmq'), 100)
  await amqp.connect()

  const telemetryProgressProto = await proto.load('api.TelemetryProgress')

  const comment = async (cardId, text) => {
    logger.info('creating comment on', cardId, 'with text:', text)

    await trello.makeRequest('post', `/1/cards/${cardId}/actions/comments`, {
      text: text || 'Failed to retrieve comment text.'
    })
  }

  amqp.listen('v1.telemetry.progress', async rmsg => {
    try {
      const msg = await proto.decode(telemetryProgressProto, rmsg.message.content)

      const { mediaId, status, progress } = msg

      logger.info('processing progress update on media', mediaId, 'status', status, 'percent', progress)
      const media = await db.getByID(mediaId)

      let statusText
      switch (status) {
        case 0:
          statusText = 'QUEUED'
          break
        case 1:
          statusText = 'DOWNLOADING'
          break
        case 2:
          statusText = 'CONVERTING'
          break
        case 3:
          statusText = 'UPLOADING'
          break
        case 4:
          statusText = 'DEPLOYED'
          break
        case 5:
          statusText = 'ERRORED'
          break
      }

      // TRELLO post
      if (media.creator === 0) {
        await comment(media.creatorId, `${statusText}: Progress ${progress}%`)
      }
    } catch (err) {
      logger.warn(`failed to update media progress`, err.message || err)
      return rmsg.ack() // TODO: maybe just drop this
    }

    return rmsg.ack()
  })

  logger.info('initialized')
}

init()
