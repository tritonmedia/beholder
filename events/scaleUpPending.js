/**
 * Triggered whenever a scaleUp is pending
 *
 * @author Jared Allard <jaredallard@outlook.com>
 * @license MIT
 * @version 1
 **/

module.exports = async (redis, data, helpers) => {
  const { logger, comment } = helpers

  for (let jobID of data) {
    logger.info(`Notifying ${jobID} of pending scale up`)
    await comment(jobID, `**Scale up pending**`)
  }
}
