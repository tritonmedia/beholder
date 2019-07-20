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
  const mediaProto = await proto.load('api.Media')

  const comment = async (cardId, text) => {
    logger.info('creating comment on', cardId, 'with text:', text)

    await trello.makeRequest('post', `/1/cards/${cardId}/actions/comments`, {
      text: text || 'Failed to retrieve comment text.'
    })
  }

  amqp.listen('v1.telemetry.progress', async rmsg => {
    try {
      const msg = await proto.decode(telemetryProgressProto, rmsg.message.content)

      const { mediaId, status, progress, host } = msg

      logger.info('processing progress update on media', mediaId, 'status', status, 'percent', progress)
      const media = await db.getByID(mediaId)

      const statusText = proto.enumToString(telemetryProgressProto, 'TelemetryStatusEntry', status)

      if (media.creator === proto.stringToEnum(mediaProto, 'CreatorType', 'Trello')) {
        let commentText = `${statusText}: Progress **${progress}%**`
        if (host) {
          commentText += ` (_${host}_)`
        }
        await comment(media.creatorId, commentText)
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
