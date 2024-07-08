const RPC = require('@hyperswarm/rpc')
const Hypercore = require('hypercore')
const Hyperswarm = require('hyperswarm')
const crypto = require('crypto')

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

class AuctionNode {
  constructor(nodeId, sharedSecret, sharedAuctionKey, sharedBidKey, secureMode = false) {
    this.nodeId = nodeId
    this.sharedSecret = sharedSecret
    this.secureMode = secureMode
    log(`Initializing AuctionNode with ID: ${nodeId}, Secure Mode: ${secureMode}`)
    this.rpc = new RPC()
    this.server = this.rpc.createServer()
    this.auctionFeed = new Hypercore(`./data/auctions-${nodeId}`, {
      valueEncoding: 'json',
      key: sharedAuctionKey,
      writable: true,
    })
    this.bidFeed = new Hypercore(`./data/bids-${nodeId}`, {
      valueEncoding: 'json',
      key: sharedBidKey,
      writable: true,
    })

    this.swarm = new Hyperswarm()
    this.peers = new Map()
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
    await this.auctionFeed.ready()
    await this.bidFeed.ready()
    const publicKey = this.server.publicKey.toString('hex')
    log(`Node ${this.nodeId} started with public key: ${publicKey}`)

    const auctionTopic = crypto.createHash('sha256').update(this.auctionFeed.key).digest()
    const bidTopic = crypto.createHash('sha256').update(this.bidFeed.key).digest()

    this.swarm.join(auctionTopic, { lookup: true, announce: true })
    this.swarm.join(bidTopic, { lookup: true, announce: true })

    this.swarm.on('connection', this.handleConnection.bind(this))

    return this.rpc.connect(this.server.publicKey)
  }

  async handleConnection(socket, info) {
    const remotePublicKey = info.publicKey.toString('hex')
    if (remotePublicKey !== this.server.publicKey.toString('hex')) {
      if (this.secureMode) {
        await this.authenticatePeer(socket, info)
      } else {
        log(`New peer connected to node ${this.nodeId} in open mode: ${remotePublicKey}`)
        this.peers.set(remotePublicKey, this.rpc.connect(info.publicKey))
      }
      this.auctionFeed.replicate(socket)
      this.bidFeed.replicate(socket)
    } else {
      log(`Ignoring self-connection for node ${this.nodeId}`)
    }
  }

  async authenticatePeer(socket, info) {
    const remotePublicKey = info.publicKey.toString('hex')
    try {
      const tempClient = this.rpc.connect(info.publicKey)
      const challenge = crypto.randomBytes(32).toString('hex')
      const response = await tempClient.request('authenticate', Buffer.from(challenge))
      const expectedResponse = crypto.createHash('sha256').update(challenge + this.sharedSecret).digest('hex')
      if (response.toString() === expectedResponse) {
        log(`Authenticated new peer connected to node ${this.nodeId}: ${remotePublicKey}`)
        this.peers.set(remotePublicKey, tempClient)
      } else {
        log(`Authentication failed for peer: ${remotePublicKey}`)
        socket.destroy()
      }
    } catch (err) {
      log(`Authentication failed for peer: ${remotePublicKey}. Error: ${err.message}`)
      socket.destroy()
    }
  }

  async handleAuthenticate(challenge) {
    const response = crypto.createHash('sha256').update(challenge + this.sharedSecret).digest('hex')
    return Buffer.from(response)
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
    await this.auctionFeed.ready()
    const auctionId = crypto.randomBytes(32).toString('hex')
    log(`Node ${this.nodeId} opening new auction: ${auctionId} for item: ${item} with starting price: ${startingPrice}`)
    const auction = { id: auctionId, item, startingPrice, status: 'open', createdBy: this.nodeId }
    await this.auctionFeed.append(auction)
    log(`Auction ${auctionId} opened successfully`)
    return { auctionId, item, startingPrice }
  }

  async localPlaceBid(auctionId, bidAmount, bidder) {
    await this.bidFeed.ready()
    log(`Node ${this.nodeId} placing bid of ${bidAmount} for auction: ${auctionId} by bidder: ${bidder}`)
    const auctionStatus = await this.getAuctionStatus(auctionId)
    if (!auctionStatus || auctionStatus.status !== 'open') {
      log(`Bid failed: Auction ${auctionId} is not open`)
      throw new Error('Auction is not open')
    }
    if (!auctionStatus.noAnyBid && bidAmount <= auctionStatus.highestBid) {
      log(`Bid failed: Bid amount ${bidAmount} is not higher than current highest bid ${auctionStatus.highestBid}`)
      throw new Error('Bid amount must be higher than current highest bid')
    }

    const bid = { auctionId, bidder, amount: bidAmount, timestamp: Date.now() }
    await this.bidFeed.append(bid)
    log(`Bid placed successfully for auction ${auctionId}`)
    return { success: true }
  }

  async localCloseAuction(auctionId) {
    await this.auctionFeed.ready()
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

    const winningBid = await this.getHighestBid(auctionId)
    const closedAuction = { ...auctionStatus, status: 'closed', winner: winningBid }
    await this.auctionFeed.append(closedAuction)
    log(`Auction ${auctionId} closed successfully`)
    return { success: true, winningBid }
  }

  async getAuctionStatus(auctionId) {
    log(`Getting status for auction: ${auctionId}`)
    for (let i = this.auctionFeed.length - 1; i >= 0; i--) {
      const auction = await this.auctionFeed.get(i)
      if (auction.id === auctionId) {
        const highestBid = await this.getHighestBid(auctionId)
        const status = { ...auction, highestBid: highestBid ? highestBid.amount : auction.startingPrice, noAnyBid: !highestBid }
        log(`Status for auction ${auctionId}: ${JSON.stringify(status)}`)
        return status
      }
    }
    log(`Auction ${auctionId} not found`)
    return null
  }

  async getHighestBid(auctionId) {
    log(`Getting highest bid for auction: ${auctionId}`)
    let highestBid = null
    for (let i = 0; i < this.bidFeed.length; i++) {
      const bid = await this.bidFeed.get(i)
      if (bid.auctionId === auctionId && (!highestBid || bid.amount > highestBid.amount)) {
        highestBid = bid
      }
    }
    log(`Highest bid for auction ${auctionId}: ${JSON.stringify(highestBid)}`)
    return highestBid
  }
}

async function waitForPeerDiscovery(node, targetPublicKey, maxWaitTime = 120000) {
  const startTime = Date.now()
  while (Date.now() - startTime < maxWaitTime) {
    log(`Node ${node.nodeId} looking for peer ${targetPublicKey}`)
    if (node.peers.has(targetPublicKey)) {
      log(`Node ${node.nodeId} found peer ${targetPublicKey}`)
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  log(`Node ${node.nodeId} failed to discover peer ${targetPublicKey} within ${maxWaitTime}ms`)
  return false
}

function messageId() {
  return crypto.randomBytes(32).toString('hex')
}

async function main() {
  log('Starting main function')
  const sharedSecret = 'your-secure-shared-secret'
  const secureMode = true // Set to false to use open mode

  const sharedAuctionKey = crypto.randomBytes(32)
  const sharedBidKey = crypto.randomBytes(32)

  const node1 = new AuctionNode('node1', sharedSecret, sharedAuctionKey, sharedBidKey, secureMode)
  const clientToNode1 = await node1.start()

  const node2 = new AuctionNode('node2', sharedSecret, sharedAuctionKey, sharedBidKey, secureMode)
  const clientToNode2 = await node2.start()

  const node3 = new AuctionNode('node3', sharedSecret, sharedAuctionKey, sharedBidKey, secureMode)
  const clientToNode3 = await node3.start()

  log('Waiting for nodes to discover each other')
  const allNodesDiscovered = await Promise.all([
    waitForPeerDiscovery(node1, node2.server.publicKey.toString('hex')),
    waitForPeerDiscovery(node1, node3.server.publicKey.toString('hex')),
    waitForPeerDiscovery(node2, node1.server.publicKey.toString('hex')),
    waitForPeerDiscovery(node2, node3.server.publicKey.toString('hex')),
    waitForPeerDiscovery(node3, node1.server.publicKey.toString('hex')),
    waitForPeerDiscovery(node3, node2.server.publicKey.toString('hex'))
  ])

  if (allNodesDiscovered.every(discovered => discovered)) {
    log('All nodes have discovered each other')

    // Client#1 opens auction: sell Pic#1 for 75 USDt
    log('Client#1 opening auction for Pic#1')
    const openAuctionResponse1 = await clientToNode1.request('openAuction', Buffer.from(JSON.stringify({
      messageId: messageId(),
      item: 'Pic#1',
      startingPrice: 75,
      createdBy: 'node1'
    })))
    const { auctionId: auctionId1 } = JSON.parse(openAuctionResponse1.toString())
    log(`Auction opened for Pic#1: ${auctionId1}`)

    // Client#2 opens auction: sell Pic#2 for 60 USDt
    log('Client#2 opening auction for Pic#2')
    const openAuctionResponse2 = await clientToNode2.request('openAuction', Buffer.from(JSON.stringify({
      messageId: messageId(),
      item: 'Pic#2',
      startingPrice: 60,
      createdBy: 'node2'
    })))
    const { auctionId: auctionId2 } = JSON.parse(openAuctionResponse2.toString())
    log(`Auction opened for Pic#2: ${auctionId2}`)

    // Client#2 makes bid for Client#1->Pic#1 with 75 USDt
    log('Client#2 placing bid for Pic#1')
    await clientToNode2.request('placeBid', Buffer.from(JSON.stringify({
      messageId: messageId(),
      auctionId: auctionId1,
      bidAmount: 75,
      bidder: 'node2'
    })))
    log('Bid placed by Client#2 for Pic#1')

    // Client#3 makes bid for Client#1->Pic#1 with 75.5 USDt
    log('Client#3 placing bid for Pic#1')
    await clientToNode3.request('placeBid', Buffer.from(JSON.stringify({
      messageId: messageId(),
      auctionId: auctionId1,
      bidAmount: 75.5,
      bidder: 'node3'
    })))
    log('Bid placed by Client#3 for Pic#1')

    // Client#2 makes bid for Client#1->Pic#1 with 80 USDt
    log('Client#2 placing second bid for Pic#1')
    await clientToNode2.request('placeBid', Buffer.from(JSON.stringify({
      messageId: messageId(),
      auctionId: auctionId1,
      bidAmount: 80,
      bidder: 'node2'
    })))
    log('Second bid placed by Client#2 for Pic#1')

    // Client#1 closes auction
    log('Client#1 closing auction for Pic#1')
    const closeAuctionResponse = await clientToNode1.request('closeAuction', Buffer.from(JSON.stringify({
      messageId: messageId(),
      auctionId: auctionId1,
      closedBy: 'node1'
    })))
    log(`Auction closed: ${closeAuctionResponse.toString()}`)

    // Get the final auction status
    log('Getting final auction status from all nodes')
    const finalStatusResponse1 = await clientToNode1.request('getAuctionStatus', Buffer.from(JSON.stringify({ auctionId: auctionId1 })))
    log(`Final auction status from node1: ${finalStatusResponse1.toString()}`)

    const finalStatusResponse2 = await clientToNode2.request('getAuctionStatus', Buffer.from(JSON.stringify({ auctionId: auctionId1 })))
    log(`Final auction status from node2: ${finalStatusResponse2.toString()}`)

    const finalStatusResponse3 = await clientToNode3.request('getAuctionStatus', Buffer.from(JSON.stringify({ auctionId: auctionId1 })))
    log(`Final auction status from node3: ${finalStatusResponse3.toString()}`)
  } else {
    log('Nodes failed to discover each other')
  }

  log('All tests completed')

  // Close nodes
  await node1.swarm.destroy()
  await node2.swarm.destroy()
  await node3.swarm.destroy()
  log('Nodes closed')
}

main().then(() => process.exit(0)).catch(console.error)
