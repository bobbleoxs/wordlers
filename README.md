# 🎮 Wordlers - Real-time Collaborative Wordle

A real-time collaborative Wordle game where two players work together to solve puzzles through a proposal-and-voting system. Perfect for couples and friends in different locations!

**🌐 Play Now:** [https://wordle-together.g57ycddpns.workers.dev](https://wordle-together.g57ycddpns.workers.dev)

## ✨ Features

- **🔄 Real-time Synchronization**: Instant updates across all connected devices using WebSockets
- **🗳️ Proposal & Voting System**: Propose words and vote to agree/disagree before submission
- **📝 Word Validation**: Only valid English words accepted (1000+ word dictionary)
- **⌨️ Virtual Keyboard**: Shows letter states (correct/present/absent) as you play
- **📱 Mobile Optimized**: Responsive design perfect for iPhone and Android devices
- **📤 Easy Sharing**: One-click URL copying to share with your partner
- **🎯 Always Solvable**: Guaranteed valid target words for every game

## 🎯 How to Play

1. **Share the Game**: Click the 📤 button to copy the URL and send to your partner
2. **Type Words**: Use the virtual keyboard to spell 5-letter words
3. **Propose**: Click "?" or press ENTER to propose your word
4. **Vote**: Your partner votes ✓ (agree) or ✗ (disagree) on your proposal
5. **Collaborate**: Work together to find the word in 6 tries!

## 🛠️ Technology Stack

- **Backend**: Cloudflare Workers (serverless edge computing)
- **Real-time State**: Durable Objects for room-based multiplayer
- **Communication**: WebSockets for instant bidirectional updates
- **Frontend**: Vanilla HTML/CSS/JavaScript (no framework dependencies)
- **Deployment**: Cloudflare Workers platform with global CDN

## 🚀 Development

### Prerequisites

- Node.js 16+
- Cloudflare account (free tier works)
- Wrangler CLI (`npm install -g wrangler`)

### Setup

```bash
# Clone the repository
git clone https://github.com/bobbleoxs/wordlers.git
cd wordlers

# Install dependencies
npm install

# Authenticate with Cloudflare
wrangler login

# Start development server
npm run dev
```

### Deployment

```bash
# Deploy to Cloudflare Workers
npm run deploy
```

## 📁 Project Structure

```
wordlers/
├── src/
│   └── worker.js       # Main Worker with Durable Object and frontend
├── wrangler.toml       # Cloudflare Workers configuration
├── package.json        # Dependencies and scripts
└── CLAUDE.md          # Development documentation
```

## 🏗️ Architecture

The game uses a single-file architecture where the Worker serves both the frontend HTML and handles WebSocket connections:

- **GameRoom Durable Object**: Manages game state for each room
- **WebSocket Handler**: Processes real-time messages between players
- **Proposal System**: Handles word suggestions and voting logic
- **Game Engine**: Validates words and applies Wordle rules

## 🎮 Game Mechanics

### Proposal System
- Either player can propose a 5-letter word
- The proposer cannot vote on their own proposal
- Non-proposers must vote to accept or reject
- Both players must agree for a word to be submitted

### Word Validation
- Checks against a dictionary of 1000+ common English words
- Prevents invalid submissions before they reach the game board
- Shows clear error messages for invalid words

### Real-time Sync
- WebSocket connections with automatic reconnection
- Heartbeat system to detect disconnections
- State synchronization on player join/reconnect

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is open source and available under the MIT License.

## 🙏 Acknowledgments

- Built with [Cloudflare Workers](https://workers.cloudflare.com/)
- Inspired by the original [Wordle](https://www.nytimes.com/games/wordle/index.html) by Josh Wardle
- Designed for collaborative gameplay between remote players

---

**Made with ❤️ for couples and friends playing together from anywhere in the world!**