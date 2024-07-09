const RPC = require('@hyperswarm/rpc')
const Hypercore = require('hypercore')
const Hyperswarm = require('hyperswarm')
const crypto = require('crypto')

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

let peerJoined = 0

class AuctionNode {
  constructor(nodeId, sharedSecret, sharedKey, secureMode = false) {
    this.nodeId = nodeId
    this.sharedSecret = sharedSecret
    this.secureMode = secureMode
    log(`Initializing AuctionNode with ID: ${nodeId}, Secure Mode: ${secureMode}`)
    this.rpc = new RPC()
    this.server = this.rpc.createServer()

    const core = new Hypercore(`./data/auction-${nodeId}`,
      // sharedKey, 
      {
        // valueEncoding: 'utf-8',
        // createIfMissing: true,
        // overwrite: false,
        // writable: true,
        // readonly: false,
      })
    this.core = core

    this.swarm = new Hyperswarm()
    this.processedMessages = new Set()

    this.setupRPC()
  }

  setupRPC() {
    log(`Setting up RPC for node ${this.nodeId}`)
    this.server.respond('openAuction', this.handleOpenAuction.bind(this))
    this.server.respond('placeBid', this.handlePlaceBid.bind(this))
    this.server.respond('closeAuction', this.handleCloseAuction.bind(this))
    this.server.respond('getAuctionStatus', this.handleGetAuctionStatus.bind(this))
    this.server.respond('authenticate', this.handleAuthenticate.bind(this))
  }

  async start() {
    await this.server.listen()
    await this.core.ready()

    const publicKey = this.server.publicKey.toString('hex')
    log(`Node ${this.nodeId} started with public key: ${publicKey}`)

    const topic = crypto.createHash('sha256').update('auction-p2p123').digest()

    this.swarm.join(topic, { server: true, client: true })
    this.swarm.on('connection', this.handleConnection.bind(this))

    await this.swarm.listen()

    return this.rpc.connect(this.server.publicKey)
  }

  async handleConnection(socket, info) {
    const remotePublicKey = info.publicKey.toString('hex')
    if (remotePublicKey !== this.server.publicKey.toString('hex')) {
      try {
        const authenticated = await this.authenticatePeer(socket, info)
        if (authenticated) {
          this.core.replicate(socket)
          // const stream = this.core.replicate(false, { live: true })
          // stream.pipe(socket).pipe(stream)
          peerJoined++
          log(`Peer ${remotePublicKey} successfully joined the application`)
        } else {
          log(`Peer ${remotePublicKey} failed to authenticate, closing connection`)
        }
      } catch (err) {
        log(`Connection failed for peer: ${remotePublicKey}. Error: ${err.message}`)
      }
    } else {
      log(`Ignoring self-connection for node ${this.nodeId}`)
    }
  }

  async authenticatePeer(socket, info) {
    const remotePublicKey = info.publicKey.toString('hex')
    try {
      const rpcClient = await this.rpc.connect(info.publicKey)
      const challenge = crypto.randomBytes(32).toString('hex')
      const response = await rpcClient.request('authenticate', Buffer.from(challenge))
      const expectedResponse = crypto.createHash('sha256').update(challenge + this.sharedSecret).digest('hex')

      if (response.toString() === expectedResponse) {
        log(`Authenticated new peer connected to node ${this.nodeId}: ${remotePublicKey}`)
        rpcClient.destroy()
        return true
      } else {
        log(`Authentication failed for peer: ${remotePublicKey}. Invalid response.`)
        return false
      }
    } catch (err) {
      log(`Authentication failed for peer: ${remotePublicKey}. Error: ${err.message}`)
      return false
    }
  }

  async handleAuthenticate(challenge) {
    const response = crypto.createHash('sha256').update(challenge + this.sharedSecret).digest('hex')
    return Buffer.from(response)
  }

  async waitW() {
    if (!this.core.writable) {
      log('Finding peers')
      const done = this.core.findingPeers()
      this.swarm.flush().then(done, done)
      await this.core.update()
    }
  }

  async waitForSync(index, peerCount) {
    return new Promise((resolve) => {
      const checkSync = async () => {
        while (true) {
          log(`wait sync peer for index ${index}`)
          const peers = this.core.peers.filter(peer => {
            log(peer.remoteLength)
            return peer.remoteLength >= index
          })

          if (peers.length >= peerCount) {
            resolve()
            break
          }
          // 使用 await 來創建一個非阻塞的延遲
          await new Promise(r => setTimeout(r, 1000))
        }
      }
      checkSync()
    })
  }


  async handleOpenAuction(reqData) {
    log(`Node ${this.nodeId} received openAuction request`)
    const { messageId, item, startingPrice, createdBy } = JSON.parse(reqData.toString())

    if (this.processedMessages.has(messageId)) {
      log(`Ignoring already processed message: ${messageId}`)
      return Buffer.from(JSON.stringify({ status: 'ignored' }))
    }

    this.processedMessages.add(messageId)

    if (createdBy === this.nodeId) {
      const result = await this.localOpenAuction(item, startingPrice)
      return Buffer.from(JSON.stringify(result))
    } else {
      return Buffer.from(JSON.stringify({ status: 'synced' }))
    }
  }

  async handlePlaceBid(reqData) {
    log(`Node ${this.nodeId} received placeBid request`)
    const { messageId, auctionId, bidAmount, bidder } = JSON.parse(reqData.toString())

    if (this.processedMessages.has(messageId)) {
      log(`Ignoring already processed message: ${messageId}`)
      return Buffer.from(JSON.stringify({ status: 'ignored' }))
    }

    this.processedMessages.add(messageId)

    if (bidder === this.nodeId) {
      const result = await this.localPlaceBid(auctionId, bidAmount, bidder)
      return Buffer.from(JSON.stringify(result))
    } else {
      return Buffer.from(JSON.stringify({ status: 'synced' }))
    }
  }

  async handleCloseAuction(reqData) {
    log(`Node ${this.nodeId} received closeAuction request`)
    const { messageId, auctionId, closedBy } = JSON.parse(reqData.toString())

    if (this.processedMessages.has(messageId)) {
      log(`Ignoring already processed message: ${messageId}`)
      return Buffer.from(JSON.stringify({ status: 'ignored' }))
    }

    this.processedMessages.add(messageId)

    if (closedBy === this.nodeId) {
      const result = await this.localCloseAuction(auctionId)
      return Buffer.from(JSON.stringify(result))
    } else {
      return Buffer.from(JSON.stringify({ status: 'synced' }))
    }
  }

  async handleGetAuctionStatus(reqData) {
    log(`Node ${this.nodeId} received getAuctionStatus request`)
    const { auctionId } = JSON.parse(reqData.toString())
    const result = await this.getAuctionStatus(auctionId)
    return Buffer.from(JSON.stringify(result))
  }

  async localOpenAuction(item, startingPrice) {
    await this.core.ready()
    await this.core.update({ wait: true })
    await this.waitW()
    const auctionId = crypto.randomBytes(32).toString('hex')
    log(`Node ${this.nodeId} opening new auction: ${auctionId} for item: ${item} with starting price: ${startingPrice}`)
    const auction = { id: auctionId, item, startingPrice, status: 'open', createdBy: this.nodeId, bids: [] }
    const event = { type: 'openAuction', auction }
    const { length, byteLength } = await this.core.append(Buffer.from(JSON.stringify(event)), { wait: true })
    log(`Auction ${auctionId} opened successfully`)
    // await this.waitForSync(length, 2)
    return { auctionId, item, startingPrice }
  }

  async localPlaceBid(auctionId, bidAmount, bidder) {
    await this.core.ready()
    await this.core.update({ wait: true })
    await this.waitW()
    log(`Node ${this.nodeId} placing bid of ${bidAmount} for auction: ${auctionId} by bidder: ${bidder}`)
    const auctionStatus = await this.getAuctionStatus(auctionId)
    if (!auctionStatus || auctionStatus.status !== 'open') {
      log(`Bid failed: Auction ${auctionId} is not open`)
      throw new Error('Auction is not open')
    }
    if (auctionStatus.bids.length > 0 && bidAmount <= auctionStatus.bids[auctionStatus.bids.length - 1].amount) {
      log(`Bid failed: Bid amount ${bidAmount} is not higher than current highest bid ${auctionStatus.bids[auctionStatus.bids.length - 1].amount}`)
      throw new Error('Bid amount must be higher than current highest bid')
    }

    const bid = { bidder, amount: bidAmount, timestamp: Date.now() }
    const event = { type: 'placeBid', auctionId, bid }
    const { length, byteLength } = await this.core.append(JSON.stringify(event), { wait: true })
    log(`Bid placed successfully for auction ${auctionId}`)
    // await this.waitForSync(length, 2)
    return { success: true }
  }

  async localCloseAuction(auctionId) {
    await this.core.ready()
    await this.core.update({ wait: true })
    await this.waitW()
    log(`Node ${this.nodeId} attempting to close auction: ${auctionId}`)
    const auctionStatus = await this.getAuctionStatus(auctionId)
    if (!auctionStatus || auctionStatus.status !== 'open') {
      log(`Close auction failed: Auction ${auctionId} is not open`)
      throw new Error('Auction is not open')
    }
    if (auctionStatus.createdBy !== this.nodeId) {
      log(`Close auction failed: Node ${this.nodeId} is not the creator of auction ${auctionId}`)
      throw new Error('Only the creator can close the auction')
    }

    const event = { type: 'closeAuction', auctionId }
    const { length, byteLength } = await this.core.append(JSON.stringify(event), { wait: true })
    log(`Auction ${auctionId} closed successfully`)
    // await this.waitForSync(length, 2)
    return { success: true, winner: auctionStatus.bids[auctionStatus.bids.length - 1] }
  }

  async getAuctionStatus(auctionId) {
    await this.core.ready()
    await this.core.update({ wait: true })
    log(`Getting status for auction: ${auctionId}`)
    let auction = null
    let bids = []

    for await (const data of this.core.createReadStream()) {
      const event = JSON.parse(data.toString()) // 將 Buffer 轉換回 JSON
      log(event)
      if (event.type === 'openAuction' && event.auction.id === auctionId) {
        auction = event.auction
      } else if (event.type === 'placeBid' && event.auctionId === auctionId) {
        bids.push(event.bid)
      } else if (event.type === 'closeAuction' && event.auctionId === auctionId) {
        auction.status = 'closed'
      }
    }

    if (auction) {
      auction.bids = bids
      log(`Status for auction ${auctionId}: ${JSON.stringify(auction)}`)
      return auction
    }
    log(`Auction ${auctionId} not found`)
    return null
  }
}

async function checkHypercoreWritable(node, maxAttempts = 100, delay = 3000) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (node.core.writable) {
      log(`Hypercore for node ${node.nodeId} is writable.`)
      return true
    }
    log(`Attempt ${attempt + 1}: Hypercore for node ${node.nodeId} is not writable yet. Waiting...`)
    await new Promise(resolve => setTimeout(resolve, delay))
  }
  log(`Failed to confirm Hypercore writability for node ${node.nodeId} after ${maxAttempts} attempts.`)
  return false
}

async function checkPeerjoined(delay = 3000) {
  let attempt = 0
  while (true) {
    if (peerJoined >= 6) {
      log(`All peer joined.`)
      return true
    }
    log(`Attempt ${attempt++}: peer is not all joined. Waiting...`)
    await new Promise(resolve => setTimeout(resolve, delay))
  }
}

async function main() {
  log('Starting main function')
  const sharedSecret = 'your-secure-shared-secret-p2p2p2p2p2p2p2p2p'
  const secureMode = true // Set to false to use open mode

  const sharedKey = Buffer.from('0123956789abcdef0123055789abcdef0223456789abcdef0123456709abcdef', 'hex')

  const node1 = new AuctionNode('node1', sharedSecret, sharedKey, secureMode)
  const node2 = new AuctionNode('node2', sharedSecret, sharedKey, secureMode)
  const node3 = new AuctionNode('node3', sharedSecret, sharedKey, secureMode)

  const client1 = await node1.start()
  const client2 = await node2.start()
  const client3 = await node3.start()

  log('Checking Hypercore writability for all nodes')
  await checkPeerjoined()

  const writableResults = await Promise.all([
    checkHypercoreWritable(node1),
    checkHypercoreWritable(node2),
    checkHypercoreWritable(node3)
  ])
  if (!writableResults.every(result => result)) {
    throw new Error('Not all Hypercore are writable. Aborting.')
  }

  // Client#1 opens auction: sell Pic#1 for 75 USDt
  log('Client#1 opening auction for Pic#1')
  const openAuctionResponse1 = await client1.request('openAuction', Buffer.from(JSON.stringify({
    messageId: crypto.randomBytes(32).toString('hex'),
    item: 'Pic#1',
    startingPrice: 75,
    createdBy: 'node1'
  })))
  const auctionId1 = JSON.parse(openAuctionResponse1.toString()).auctionId
  log(`Auction opened for Pic#1: ${auctionId1}`)

  // Client#2 opens auction: sell Pic#2 for 60 USDt
  log('Client#2 opening auction for Pic#2')
  const openAuctionResponse2 = await client2.request('openAuction', Buffer.from(JSON.stringify({
    messageId: crypto.randomBytes(32).toString('hex'),
    item: 'Pic#2',
    startingPrice: 60,
    createdBy: 'node2'
  })))
  const auctionId2 = JSON.parse(openAuctionResponse2.toString()).auctionId
  log(`Auction opened for Pic#2: ${auctionId2}`)

  // Wait for auctions to propagate
  await new Promise(resolve => setTimeout(resolve, 10 * 1000))

  // Client#2 makes bid for Client#1->Pic#1 with 75 USDt
  log('Client#2 placing bid for Pic#1')
  await client2.request('placeBid', Buffer.from(JSON.stringify({
    messageId: crypto.randomBytes(32).toString('hex'),
    auctionId: auctionId1,
    bidAmount: 75,
    bidder: 'node2'
  })))
  log('Bid placed by Client#2 for Pic#1')

  // Client#3 makes bid for Client#1->Pic#1 with 75.5 USDt
  log('Client#3 placing bid for Pic#1')
  await client3.request('placeBid', Buffer.from(JSON.stringify({
    messageId: crypto.randomBytes(32).toString('hex'),
    auctionId: auctionId1,
    bidAmount: 75.5,
    bidder: 'node3'
  })))
  log('Bid placed by Client#3 for Pic#1')

  // Client#2 makes bid for Client#1->Pic#1 with 80 USDt
  log('Client#2 placing second bid for Pic#1')
  await client2.request('placeBid', Buffer.from(JSON.stringify({
    messageId: crypto.randomBytes(32).toString('hex'),
    auctionId: auctionId1,
    bidAmount: 80,
    bidder: 'node2'
  })))
  log('Second bid placed by Client#2 for Pic#1')

  // Wait for bids to propagate
  await new Promise(resolve => setTimeout(resolve, 2000))

  // Client#1 closes auction
  log('Client#1 closing auction for Pic#1')
  const closeAuctionResponse = await client1.request('closeAuction', Buffer.from(JSON.stringify({
    messageId: crypto.randomBytes(32).toString('hex'),
    auctionId: auctionId1,
    closedBy: 'node1'
  })))
  log(`Auction closed: ${closeAuctionResponse.toString()}`)

  // Wait for auction close to propagate
  await new Promise(resolve => setTimeout(resolve, 2000))

  // Get the final auction status
  log('Getting final auction status from all nodes')
  const finalStatusResponse1 = await client1.request('getAuctionStatus', Buffer.from(JSON.stringify({ auctionId: auctionId1 })))
  log(`Final auction status from node1: ${finalStatusResponse1.toString()}`)

  const finalStatusResponse2 = await client2.request('getAuctionStatus', Buffer.from(JSON.stringify({ auctionId: auctionId1 })))
  log(`Final auction status from node2: ${finalStatusResponse2.toString()}`)

  const finalStatusResponse3 = await client3.request('getAuctionStatus', Buffer.from(JSON.stringify({ auctionId: auctionId1 })))
  log(`Final auction status from node3: ${finalStatusResponse3.toString()}`)

  log('All tests completed')

  // Close nodes
  await Promise.all([
    node1.swarm.destroy(),
    node2.swarm.destroy(),
    node3.swarm.destroy()
  ])
  log('Nodes closed')
}

main().then(() => process.exit(0)).catch(error => {
  console.error('An error occurred:', error)
  process.exit(1)
})
