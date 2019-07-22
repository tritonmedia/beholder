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
const Prom = require('triton-core/prom')

const init = async () => {
  const config = await Config('events')
  const trello = new Trello(config.keys.trello.key, config.keys.trello.token)

  const prom = Prom.new('beholder')
  Prom.expose()
  const metrics = {
    progress_updates_total: new prom.Counter({
      name: 'beholder_progress_updates_total',
      help: 'Total number of messages processed in this processes lifetime',
      labelNames: ['status']
    }),
    trello_comments_total: new prom.Counter({
      name: 'beholder_trello_comments',
      help: 'Total trello comments crreated in this processes lifetime',
      labelNames: []
    })
  }

  const db = new Storage()
  const amqp = new AMQP(dyn('rabbitmq'), 100, 2, prom)
  await amqp.connect()

  const telemetryProgressProto = await proto.load('api.TelemetryProgress')
  const mediaProto = await proto.load('api.Media')

  const comment = async (cardId, text) => {
    logger.info('creating comment on', cardId, 'with text:', text)

    await trello.makeRequest('post', `/1/cards/${cardId}/actions/comments`, {
      text: text || 'Failed to retrieve comment text.'
    })

    metrics.trello_comments_total.inc()
  }

  amqp.listen('v1.telemetry.progress', async rmsg => {
    try {
      const msg = await proto.decode(telemetryProgressProto, rmsg.message.content)

      const { mediaId, status, progress, host } = msg

      logger.info('processing progress update on media', mediaId, 'status', status, 'percent', progress)
      const statusText = proto.enumToString(telemetryProgressProto, 'TelemetryStatusEntry', status)

      metrics.progress_updates_total.inc({
        status: statusText.toLowerCase()
      })

      const media = await db.getByID(mediaId)

      if (media.creator === proto.stringToEnum(mediaProto, 'CreatorType', 'TRELLO')) {
        let commentText = `${statusText}: Progress **${progress}%**`
        if (host) {
          commentText += ` (_${host}_)`
        }
        await comment(media.creatorId, commentText)
      }
    } catch (err) {
      logger.warn(`failed to update media progress`, err.message || err)
      return rmsg.ack()
    }

    return rmsg.ack()
  })

  logger.info('initialized')
}

init()
