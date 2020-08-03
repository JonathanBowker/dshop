const ethers = require('ethers')

const { marketplaceAbi } = require('@origin/utils/marketplace')

const { Network, Shop, Transaction } = require('../models')
const queues = require('./queues')
const { ListingID } = require('../utils/id')
const { getIpfsHashFromBytes32 } = require('../utils/_ipfs')
const { getLogger } = require('../utils/logger')
const { IS_TEST } = require('../utils/const')
const { Sentry } = require('../sentry')
const { TransactionStatuses } = require('../enums')

const log = getLogger('listingCreatedProcessor')

// Wait for 2 blocks confirmation before considering a tx mined.
const NUM_BLOCKS_CONFIRMATION = IS_TEST ? 0 : 2

/**
 * Function to start the queue processing.
 */
function attachToQueue() {
  const queue = queues['listingCreatedQueue']
  queue.process(processor)
  queue.resume() // Start if paused
}

/**
 * Waits for a blockchain ListingCreated transaction to get confirmed,
 * then updates the associate shop's ListingId.
 *
 * @param {Object} job: Bull job object.
 * job.data is expected to have the following fields:
 *   {string} txHash: hash of the ListingCreated tx to watch.
 *   {string} fromAddress: Address that sent the transaction
 *   {number} shopId: Id of the shop
 * @returns {Promise<null||{receipt: ethers.TransactionReceipt, listingId: number, offerId: number, ipfsHash: string}>}
 * @throws
 */
async function processor(job) {
  const queueLog = (progress, str) => {
    job.log(str)
    job.progress(progress)
  }
  const jobId = `${job.queue.name}-${job.id}` // Prefix with queue name since job ids are not unique across queues.

  const { txHash, fromAddress, shopId } = job.data
  log.info(
    `Waiting for ListingCreated tx. ShopId: {shopId} Hash: ${txHash} fromAddress: ${fromAddress} `
  )
  let confirmation

  try {
    // Load the associated shop.
    const shop = await Shop.findOne({ where: { id: shopId } })
    if (!shop) {
      throw new Error(`Failed loading shop with id ${shopId}`)
    }

    const network = await Network.findOne({
      where: { networkId: shop.networkId, active: true }
    })
    const provider = new ethers.providers.JsonRpcProvider(network.provider)
    const marketplace = new ethers.Contract(
      network.marketplaceContract,
      marketplaceAbi,
      provider
    )

    // Load the transaction from the DB.
    const transaction = await Transaction.findOne({
      networkId: network.id,
      shopId,
      fromAddress,
      hash: txHash
    })
    if (!transaction) {
      throw new Error(
        `No transaction found in the DB with hash ${txHash} for shop ${shopId} and wallet ${fromAddress}`
      )
    }

    // Load the tx from the blockchain based on its hash.
    queueLog(25, 'Loading tx from the blockchain')
    const tx = await provider.getTransaction(txHash)
    if (!tx) {
      throw new Error(`Transaction with hash ${txHash} not found`)
    }
    log.info(`Loaded tx with hash ${txHash} from the network`)

    // Wait for the tx to get mined.
    queueLog(50, `Waiting for tx ${txHash} to get confirmed`)
    log.info('Waiting for tx ${txHash} confirmation...')
    confirmation = await _waitForListingCreatedTxConfirmation(marketplace, tx)
    const { receipt, listingId } = confirmation

    if (receipt.status) {
      // Update the transaction in the DB.
      const lid = new ListingID(listingId, network.networkId).toString() // fully qualified listingId.
      await transaction.update({
        status: TransactionStatuses.Confirmed,
        blockNumber: receipt.blockNumber,
        listingId: lid,
        jobId
      })
      // Check the shop still does not have a listingId (a concurrent ListingCreated tx could
      // have been mined while we were waiting for this tx to get mined).
      await shop.load()
      if (shop.listingId) {
        log.info(
          `ListingId ${shop.listingId} linked to shop ${shopId} while waiting for ${txHash}.`
        )
      } else {
        await shop.update({ listingId: lid })
        log.info(
          `Shop ${shopId}: tx ${txHash} mined, updated listingId to ${lid}`
        )
      }
    } else {
      log.info(`Shop ${shopId}: tx with hash ${txHash} was reverted.`)
      await transaction.update({
        status: TransactionStatuses.Failed,
        blockNumber: receipt.blockNumber,
        jobId
      })
    }

    queueLog(100, 'Finished')
  } catch (e) {
    // Log the exception and rethrow so that the job gets retried.
    Sentry.captureException(e)
    log.error(
      `Waiting for ListingCreated for shop ${shopId} txHash ${txHash} failed:`,
      e
    )
    throw e
  }

  return confirmation
}

/**
 * Waits a marketplace listing creation transaction to get mined.
 * Note: This is blocking. No timeout is set.
 *
 * @param {ethers.Contract} marketplace
 * @param {ethers.Transaction} tx
 * @returns {Promise<{receipt: ethers.TransactionReceipt, listingId: number|null, ipfsHash: string||null }>}
 * @private
 */
async function _waitForListingCreatedTxConfirmation(marketplace, tx) {
  // Wait for the tx to get mined with some blocks confirmation.
  const receipt = await tx.wait(NUM_BLOCKS_CONFIRMATION)
  if (!receipt.status) {
    // EVM reverted the transaction.
    return { receipt, listingId: null, ipfsHash: null }
  }

  // Look for the LitingCreated event in the receipt.
  const listingLog = receipt.logs
    .map((l) => {
      try {
        return marketplace.interface.parseLog(l)
      } catch (e) {
        /* Ignore */
      }
    })
    .filter((l) => l)
    .find((e) => e.name === 'ListingCreated')

  if (!listingLog) {
    throw new Error(`No ListingCreated log found for tx ${tx.hash}`)
  }

  // Extract listingId and ipfsHash from the ListingCreated event.
  const listingId = listingLog.args.listingID.toNumber()
  const ipfsHash = getIpfsHashFromBytes32(listingLog.args.ipfsHash)

  return { receipt, listingId, ipfsHash }
}
module.exports = { processor, attachToQueue }
