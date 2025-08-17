# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Wordlers** is a real-time collaborative Wordle game designed for couples in different cities. Two players work together on the same puzzle through a proposal-and-voting system, with all actions syncing instantly across devices.

## Architecture

### Technology Stack
- **Backend**: Cloudflare Workers with Durable Objects
- **Frontend**: Vanilla HTML/CSS/JavaScript (embedded in Worker)
- **Real-time Communication**: WebSockets via Durable Objects
- **Deployment**: Cloudflare Workers platform

### Project Structure
```
wordler/
├── src/
│   └── worker.js          # Main Worker + Durable Object + Frontend HTML
├── wrangler.toml          # Cloudflare Workers configuration
├── package.json           # Dependencies and scripts
└── node_modules/          # Wrangler CLI dependencies
```

## Development Commands

```bash
# Start development server with hot reload
npm run dev
# or
wrangler dev

# Deploy to production
npm run deploy
# or  
wrangler deploy

# Install dependencies
npm install
```

## Game Mechanics

### Core Flow
1. **Room Creation**: Player 1 visits URL → generates unique room code in URL hash
2. **Joining**: Player 2 uses same URL to join the room
3. **Proposal**: Either player types 5-letter word and clicks "?" to propose
4. **Voting**: Both players vote with "✓" (agree) or "✗" (disagree) buttons
5. **Submission**: If both agree, word submits to game board with Wordle color coding
6. **Progression**: Continue until word found or 6 attempts used

### Real-time Sync
- All game state managed by Durable Objects
- WebSocket connections for instant updates
- Automatic reconnection with exponential backoff
- Heartbeat system to detect disconnections

## Code Architecture

### Durable Object: GameRoom
- **Purpose**: Manages individual game rooms and real-time state
- **Key Methods**:
  - `handleMessage()`: Processes proposal, vote, and heartbeat messages
  - `handleProposal()`: Validates and broadcasts word proposals
  - `handleVote()`: Collects votes and triggers word submission
  - `checkVotes()`: Determines when to submit/reject proposals
  - `submitWord()`: Processes Wordle logic and updates board

### Frontend: CollaborativeWordle Class
- **Purpose**: Manages client-side game state and WebSocket communication
- **Key Methods**:
  - `connect()`: Establishes WebSocket connection with reconnection logic
  - `proposeWord()`: Sends word proposals to server
  - `vote()`: Sends agreement/disagreement votes
  - `updateUI()`: Syncs game board and proposal state

### Game State Structure
```javascript
{
  roomCode: string,
  targetWord: string,        // Daily word for the room
  currentRow: number,        // Current guess row (0-5)
  gameState: 'playing'|'won'|'lost',
  board: string[][],         // 6x5 grid of letters
  boardStates: string[][],   // 6x5 grid of states (correct/present/absent)
  proposal: {                // Current active proposal
    word: string,
    proposer: playerId,
    timestamp: number
  },
  votes: {playerId: boolean}, // Vote collection
  players: {playerId: {name, lastSeen, online}},
  createdAt: number,
  lastUpdate: number
}
```

## Key Features Implemented

### ✅ Completed Features
- Real-time WebSocket communication
- Proposal and voting system
- Wordle game logic with color coding
- Mobile-responsive design optimized for iPhone
- Room-based multiplayer with URL sharing
- Automatic reconnection handling
- Player presence detection
- Daily deterministic word selection per room

### 🔧 Technical Details
- **Word Selection**: Deterministic based on room code + date hash
- **Vote Processing**: Auto-approve for single player, requires consensus for multiple
- **Cleanup**: Removes players inactive for 2+ minutes
- **Error Handling**: Comprehensive validation for proposals and votes
- **Mobile Optimization**: Touch-friendly UI with proper viewport settings

## Development Guidelines

### Code Style
- Use modern JavaScript (ES6+) features
- Maintain single-file architecture for simplicity
- Keep inline styles for easy deployment
- Use async/await for asynchronous operations

### WebSocket Message Format
```javascript
// Outgoing messages
{type: 'propose', word: string}
{type: 'vote', agrees: boolean}
{type: 'heartbeat'}

// Incoming messages  
{type: 'gameState', gameState: object}
{type: 'proposal', proposal: object, gameState: object}
{type: 'vote', playerId: string, agrees: boolean, votes: object}
{type: 'wordSubmitted', word: string, result: array, gameState: object}
{type: 'proposalRejected', gameState: object}
{type: 'playerJoined|playerLeft', playerId: string, players: object}
{type: 'error', message: string}
```

### Error Handling
- Validate all inputs (word length, game state)
- Graceful WebSocket reconnection
- User-friendly error messages
- Console logging for debugging

### Mobile Considerations
- Touch-optimized button sizes (50px minimum)
- Responsive grid layout
- Proper viewport meta tag
- Optimized font sizes for mobile screens

## Deployment Configuration

### Wrangler Configuration
- **Durable Objects**: `GAME_ROOMS` binding to `GameRoom` class
- **Compatibility Date**: 2024-01-01
- **Production Environment**: `wordle-together-prod`

### Environment Setup
1. Install Wrangler CLI: `npm install -g wrangler`
2. Authenticate: `wrangler login`
3. Enable Durable Objects in Cloudflare dashboard
4. Deploy: `wrangler deploy`

## Testing Strategy

### Manual Testing
- Multi-device testing with two phones/browsers
- Network disconnection/reconnection scenarios  
- Rapid proposal/voting interactions
- Room joining with URL sharing
- Mobile responsiveness across screen sizes

### Key Test Scenarios
1. **Basic Flow**: Create room → Share URL → Propose → Vote → Submit
2. **Reconnection**: Disconnect mid-game → Verify state sync on reconnect
3. **Mobile UX**: Test all interactions on iPhone Safari
4. **Concurrent Users**: Multiple rooms with different players
5. **Edge Cases**: Invalid words, rapid clicking, network issues

## Success Criteria

The game is considered successful when:
- Two people on separate phones in different cities can play together
- Perfect real-time synchronization without refresh issues
- No technical friction in joining or playing
- Smooth mobile experience on iPhone screens
- Reliable WebSocket connections with auto-recovery

## Future Enhancements

### Potential Improvements
- Word validation against dictionary API
- Game history and statistics
- Custom room names instead of random codes
- Sound effects and haptic feedback
- Dark mode support
- Spectator mode for additional players