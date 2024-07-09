# Decentralized Auction System

This project implements a decentralized auction system using Node.js and the Hyperswarm network. It allows multiple nodes to participate in creating auctions, placing bids, and closing auctions in a peer-to-peer environment.

## Overview

This system utilizes a simple data propagation method rather than distributed storage technology. Each time new data (such as a new auction or bid) is created, it is broadcast to all connected nodes in the network. This approach ensures that all nodes maintain an up-to-date copy of the auction data without relying on a centralized database or complex distributed storage systems.

## Features

- Create and join a decentralized network of auction nodes
- Open new auctions with a starting price
- Place bids on open auctions
- Close auctions and determine the winning bid
- Secure mode with peer authentication
- Real-time synchronization of auction data across all nodes through broadcasting
- In-memory storage of auction data on each node

## Data Propagation

- When a node creates a new auction or places a bid, it first processes the action locally.
- The node then broadcasts the action to all other connected nodes in the network.
- Each receiving node updates its local data storage with the new information.
- This ensures that all nodes in the network have a consistent view of the auction state.

## Prerequisites

- Node.js (v12 or higher recommended)
- npm (Node Package Manager)

## Installation

1. Clone the repository:
    ```bash
    git clone https://github.com/yourusername/decentralized-auction-system.git
    cd decentralized-auction-system
    ```

2. Install dependencies:
    ```bash
    npm install
    ```

## Usage

1. Set up the configuration:
- Adjust the `sharedSecret` in the `main()` function for secure mode.
- Set `secureMode` to `true` or `false` as needed.

2. Run the application:
    ```bash
    npm run start
    ```

3. The system will create three nodes that discover each other and perform a series of test actions:
- Opening auctions
- Placing bids
- Closing an auction
- Retrieving auction status

## Code Structure

- `AuctionNode` class: Represents a node in the auction network.
- `setupRPC()`: Configures RPC methods for the node.
- `start()`: Initializes the node and joins the Hyperswarm network.
- `handleConnection()`: Manages new peer connections.
- `authenticatePeer()`: Authenticates peers in secure mode.
- Various handler methods for auction operations (open, bid, close, status).
- `broadcastToAllNodes()`: Propagates actions to all connected nodes.

## Security

The system supports a secure mode where peers must authenticate using a shared secret. This helps prevent unauthorized access to the auction network.

## Limitations and Future Improvements

- Implement distributed storage using Hypercore or Hyperbee:
  - Replace the current in-memory storage with Hypercore for append-only logs of auction events.
  - Use Hyperbee for efficient key-value storage of auction and bid data.
  - This change will improve data persistence and consistency across the network.

- Enhance data synchronization:
  - Utilize Hypercore's built-in replication to ensure efficient and reliable data propagation.
  - Implement conflict resolution strategies for concurrent updates.

## License

This project is licensed under the MIT License.
