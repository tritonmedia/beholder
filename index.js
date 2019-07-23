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
const request = require('request-promise-native')

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
  const telemetryStatusProto = await proto.load('api.TelemetryStatus')
  const mediaProto = await proto.load('api.Media')

  const comment = async (cardId, text) => {
    logger.info('creating comment on', cardId, 'with text:', text)

    await trello.makeRequest('post', `/1/cards/${cardId}/actions/comments`, {
      text: text || 'Failed to retrieve comment text.'
    })

    metrics.trello_comments_total.inc()
  }

  const lists = config.instance.flow_ids

  amqp.listen('v1.telemetry.status', async rmsg => {
    const msg = proto.decode(telemetryStatusProto, rmsg.message.content)
    const { mediaId, status } = msg

    logger.info(`processing status update for media ${mediaId}, status: ${status}`)

    await db.updateStatus(mediaId, status)

    if (process.env.NO_TRELLO) {
      return rmsg.ack()
    }

    const statusText = await proto.enumToString(telemetryStatusProto, 'TelemetryStatusEntry', status)

    const media = await db.getByID(mediaId)

    if (media.creator !== 1) {
      return logger.warn('skipping Trello update for non-trello media', mediaId)
    }

    const listPointer = lists[statusText.toLowerCase()]
    if (listPointer) {
      logger.info(`moving media card ${mediaId} (card id ${media.creatorId})`)
      await trello.makeRequest('put', `/1/cards/${media.creatorId}`, {
        idList: listPointer,
        pos: 2
      })
    } else {
      logger.warn('unable to find list for status', status, `(${statusText})`, `avail ([${Object.keys(lists)}])`)
    }

    try {
      // post to telegram
      if (media.status === proto.stringToEnum(telemetryStatusProto, 'TelemetryStatusEntry', 'DEPLOYED')) {
        // telegram code
        // TODO(jaredallard): move this outside
        if (config.instance.telegram && config.instance.telegram.enabled) {
          logger.info(`informing telegram that media '${mediaId}' is available`)
          await request({
            url: `https://api.telegram.org/bot${config.keys.telegram.token}/sendMessage`,
            qs: {
              chat_id: config.instance.telegram.channel,
              text: `*New Anime:* ${media.name}\nKitsu: https://kitsu.io/anime/${media.metadataId}`,
              parse_mode: 'markdown'
            }
          })
        }

        // tell emby to refresh
        if (config.keys.emby && config.keys.emby.token && config.instance.emby && config.instance.emby.enabled) {
          logger.info(`telling emby to refresh at ${config.instance.emby.host}`)
          await request({
            url: `${config.instance.emby.host}/emby/library/refresh`,
            qs: {
              api_key: config.keys.emby.token
            }
          })
        }
      }
    } catch (err) {
      logger.warn('failed to run deployed hooks:', err.message || err)
    }

    rmsg.ack()
  })

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
