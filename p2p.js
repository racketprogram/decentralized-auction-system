const RPC = require('@hyperswarm/rpc')
const Hypercore = require('hypercore')
const Hyperswarm = require('hyperswarm')
const crypto = require('crypto')

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

class AuctionNode {
  constructor(nodeId, sharedSecret, secureMode = false) {
    this.nodeId = nodeId
    this.sharedSecret = sharedSecret
    this.secureMode = secureMode
    log(`Initializing AuctionNode with ID: ${nodeId}, Secure Mode: ${secureMode}`)
    this.rpc = new RPC()
    this.server = this.rpc.createServer()
    this.auctions = new Hypercore(`./data/auctions-${nodeId}`, {
      valueEncoding: 'json'
    })
    this.bids = new Hypercore(`./data/bids-${nodeId}`, {
      valueEncoding: 'json'
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
    const publicKey = this.server.publicKey.toString('hex')
    log(`Node ${this.nodeId} started with public key: ${publicKey}`)
    
    const topic = crypto.createHash('sha256')
      .update('auction-app-topic')
      .digest()
    
    log(`Joining swarm with topic: ${topic.toString('hex')}`)
    this.swarm.join(topic, { lookup: true, announce: true })
    
    this.swarm.on('connection', this.handleConnection.bind(this))

    return publicKey
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
    const { messageId, item, startingPrice } = JSON.parse(reqData.toString())
    
    if (this.processedMessages.has(messageId)) {
      log(`Ignoring already processed message: ${messageId}`)
      return Buffer.from(JSON.stringify({ status: 'ignored' }))
    }
    
    this.processedMessages.add(messageId)
    
    const result = await this.openAuction(item, startingPrice)
    
    const fullAuctionInfo = {
      messageId,
      auctionId: result.auctionId,
      item,
      startingPrice,
      createdBy: this.nodeId,
      status: 'open'
    }
    
    await this.broadcastToAllNodes('openAuction', fullAuctionInfo)
    return Buffer.from(JSON.stringify(result))
  }

  async handlePlaceBid(reqData) {
    log(`Node ${this.nodeId} received placeBid request`)
    const { messageId, auctionId, bidAmount, bidder } = JSON.parse(reqData.toString())
    
    if (this.processedMessages.has(messageId)) {
      log(`Ignoring already processed message: ${messageId}`)
      return Buffer.from(JSON.stringify({ status: 'ignored' }))
    }
    
    this.processedMessages.add(messageId)
    
    const result = await this.placeBid(auctionId, bidAmount, bidder)
    
    const fullBidInfo = {
      messageId,
      auctionId,
      bidAmount,
      bidder,
      timestamp: Date.now()
    }
    
    await this.broadcastToAllNodes('placeBid', fullBidInfo)
    return Buffer.from(JSON.stringify(result))
  }

  async handleCloseAuction(reqData) {
    log(`Node ${this.nodeId} received closeAuction request`)
    const { messageId, auctionId } = JSON.parse(reqData.toString())
    
    if (this.processedMessages.has(messageId)) {
      log(`Ignoring already processed message: ${messageId}`)
      return Buffer.from(JSON.stringify({ status: 'ignored' }))
    }
    
    this.processedMessages.add(messageId)
    
    const result = await this.closeAuction(auctionId)
    
    const fullCloseInfo = {
      messageId,
      auctionId,
      closedBy: this.nodeId,
      winningBid: result.winningBid,
      status: 'closed'
    }
    
    await this.broadcastToAllNodes('closeAuction', fullCloseInfo)
    return Buffer.from(JSON.stringify(result))
  }

  async handleGetAuctionStatus(reqData) {
    log(`Node ${this.nodeId} received getAuctionStatus request`)
    const { auctionId } = JSON.parse(reqData.toString())
    const result = await this.getAuctionStatus(auctionId)
    return Buffer.from(JSON.stringify(result))
  }

  async openAuction(item, startingPrice) {
    const auctionId = crypto.randomBytes(32).toString('hex')
    log(`Node ${this.nodeId} opening new auction: ${auctionId} for item: ${item} with starting price: ${startingPrice}`)
    const auction = { id: auctionId, item, startingPrice, status: 'open', createdBy: this.nodeId }
    await this.auctions.append(auction)
    log(`Auction ${auctionId} opened successfully`)
    return { auctionId }
  }

  async placeBid(auctionId, bidAmount, bidder) {
    log(`Node ${this.nodeId} placing bid of ${bidAmount} for auction: ${auctionId} by bidder: ${bidder}`)
    const auctionStatus = await this.getAuctionStatus(auctionId)
    if (!auctionStatus || auctionStatus.status !== 'open') {
      log(`Bid failed: Auction ${auctionId} is not open`)
      throw new Error('Auction is not open')
    }
    if (bidAmount <= auctionStatus.highestBid) {
      log(`Bid failed: Bid amount ${bidAmount} is not higher than current highest bid ${auctionStatus.highestBid}`)
      throw new Error('Bid amount must be higher than current highest bid')
    }
    
    const bid = { auctionId, bidder, amount: bidAmount, timestamp: Date.now() }
    await this.bids.append(bid)
    log(`Bid placed successfully for auction ${auctionId}`)
    return { success: true }
  }

  async closeAuction(auctionId) {
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
    await this.auctions.append(closedAuction)
    log(`Auction ${auctionId} closed successfully`)
    return { success: true, winningBid }
  }

  async getAuctionStatus(auctionId) {
    log(`Getting status for auction: ${auctionId}`)
    for (let i = this.auctions.length - 1; i >= 0; i--) {
      const auction = await this.auctions.get(i)
      if (auction.id === auctionId) {
        const highestBid = await this.getHighestBid(auctionId)
        const status = { ...auction, highestBid: highestBid ? highestBid.amount : auction.startingPrice }
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
    for (let i = 0; i < this.bids.length; i++) {
      const bid = await this.bids.get(i)
      if (bid.auctionId === auctionId && (!highestBid || bid.amount > highestBid.amount)) {
        highestBid = bid
      }
    }
    log(`Highest bid for auction ${auctionId}: ${JSON.stringify(highestBid)}`)
    return highestBid
  }

  async broadcastToAllNodes(method, data) {
    log(`Broadcasting ${method} to all nodes`)
    const serializedData = Buffer.from(JSON.stringify(data))
    log(`broadcastToAllNodes this.peers length ${this.peers.size}`)
    for (const [peerKey, client] of this.peers) {
      if (peerKey === this.server.publicKey.toString('hex')) {
        log(`Skipping self-broadcast for node ${this.nodeId}`)
        continue;
      }
      try {
        log(`Sending ${method} to peer: ${peerKey}`)
        await client.request(method, serializedData)
        log(`Successfully sent ${method} to peer: ${peerKey}`)
      } catch (err) {
        console.error(`Failed to broadcast ${method} to peer ${peerKey}:`, err.message)
      }
    }
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

async function main() {
  log('Starting main function')
  const sharedSecret = 'your-secure-shared-secret'
  const secureMode = true // 設置為 false 以使用開放模式

  const node1 = new AuctionNode('node1', sharedSecret, secureMode)
  const node1PublicKey = await node1.start()

  const node2 = new AuctionNode('node2', sharedSecret, secureMode)
  const node2PublicKey = await node2.start()

  log('Waiting for nodes to discover each other')
  const node2DiscoveredNode1 = await waitForPeerDiscovery(node2, node1PublicKey)
  const node1DiscoveredNode2 = await waitForPeerDiscovery(node1, node2PublicKey)

  if (node2DiscoveredNode1 && node1DiscoveredNode2) {
    log('Both nodes have discovered each other')
    const clientToNode1 = node2.peers.get(node1PublicKey)

    if (clientToNode1) {
      try {
        log('Opening auction from node2 to node1')
        const messageId = crypto.randomBytes(32).toString('hex')
        const openAuctionResponse = await clientToNode1.request('openAuction', Buffer.from(JSON.stringify({ 
          messageId,
          item: 'Pic#1', 
          startingPrice: 75 
        })))
        const { auctionId } = JSON.parse(openAuctionResponse.toString())
        log(`Auction opened: ${auctionId}`)

        log('Getting auction status')
        const statusResponse = await clientToNode1.request('getAuctionStatus', Buffer.from(JSON.stringify({ auctionId })))
        log(`Auction status: ${statusResponse.toString()}`)

        log('Placing bid')
        const bidMessageId = crypto.randomBytes(32).toString('hex')
        await clientToNode1.request('placeBid', Buffer.from(JSON.stringify({ 
          messageId: bidMessageId,
          auctionId, 
          bidAmount: 80,
          bidder: 'node2'
        })))
        log('Bid placed')

        log('Getting updated auction status')
        const newStatusResponse = await clientToNode1.request('getAuctionStatus', Buffer.from(JSON.stringify({ auctionId })))
        log(`New auction status: ${newStatusResponse.toString()}`)

        log('Closing auction')
        const closeMessageId = crypto.randomBytes(32).toString('hex')
        const closeAuctionResponse = await clientToNode1.request('closeAuction', Buffer.from(JSON.stringify({ 
          messageId: closeMessageId,
          auctionId 
        })))
        log(`Auction closed: ${closeAuctionResponse.toString()}`)
      } catch (error) {
        console.error('Error during auction process:', error.message)
      }
    } else {
      console.error('Failed to get client connection to node1')
    }
  } else {
    console.error('Nodes failed to discover each other')
  }

  // 等待一段時間以確保所有操作完成
  await new Promise(resolve => setTimeout(resolve, 5000))

  // 關閉節點
  await node1.swarm.destroy()
  await node2.swarm.destroy()
  log('Nodes closed')
}

main().catch(console.error)