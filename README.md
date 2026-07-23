# Smart Router v6.1.0 🔀

**AI Gateway** — Intelligent model routing, circuit breaker, rate limiting, semantic cache, and real-time dashboard.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| **🧠 Tier-Based Routing** | Distribute requests across models by priority tiers with weighted load balancing |
| **🛡️ Circuit Breaker** | Automatic provider isolation when failures exceed threshold |
| **⏱️ Rate Limiting** | Per-IP and per-Key sliding window rate limiter |
| **💾 Semantic Cache** | SQLite-backed response caching (optional) |
| **🔄 Auto Failover** | 429/502 → auto switch to next available provider |
| **📊 Real-Time Dashboard** | WebSocket-powered monitoring with ECharts visualizations |
| **💰 Cost Tracking** | Per-model cost calculation and daily/monthly reports |
| **🔐 Guardrails** | PII masking, prompt injection detection, content filtering |
| **🌐 OpenAI Compatible** | Drop-in replacement for OpenAI API endpoints |
| **⚡ Health Checks** | Periodic provider health monitoring |
| **🔌 Extensible** | Easy to add new providers and models via JSON config |

## 🚀 Quick Start

### Prerequisites
- Node.js >= 18

### Install

```bash
git clone https://github.com/your-username/smart-router.git
cd smart-router
npm install
```

### Configure

```bash
cp .env.example .env
# Edit .env with your settings

cp config/config.example.json config/config.json
# Add your providers and models
```

### Start

```bash
npm start
```

Open `http://127.0.0.1:7878/dashboard` to see the dashboard.

### Docker

```bash
docker build -t smart-router .
docker run -p 7878:7878 \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/data:/app/data \
  smart-router
```

## 🏗️ Architecture

```
Client → Smart Router → Provider 1 (Tier 0)
                      → Provider 2 (Tier 1)  
                      → Provider 3 (Tier 2)  ← Fallback
         ↓
    [Circuit Breaker]
    [Rate Limiter]  
    [Semantic Cache]
    [Guardrails]
    [Cost Tracker]
         ↓
    Dashboard (WebSocket实时)
```

### Request Flow

1. Incoming request hits `/v1/chat/completions`
2. Rate limiter checks IP/Key quota
3. Guardrails scan input for PII/injections
4. Tier-based router picks best available model
5. Circuit breaker checks provider health
6. Request forwarded to provider with timeout
7. On failure → automatic fallback to next tier
8. Response streamed back, cost recorded, stats updated

## 📡 API Endpoints

### Proxy (OpenAI-compatible)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/completions` | Chat completions (streaming + non-streaming) |

### Management API
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/stats` | Request statistics |
| GET | `/api/providers` | List providers |
| POST | `/api/providers` | Add/update provider |
| GET | `/api/models` | List models with stats |
| POST | `/api/models` | Add/update model |
| DELETE | `/api/models/:name` | Delete model |
| GET | `/api/routes` | Get routing config |
| POST | `/api/routes` | Update routing config |
| GET | `/api/cost` | Cost overview & daily breakdown |
| POST | `/api/system/reload` | Hot reload config |
| GET | `/api/config` | Current config (read-only) |

### WebSocket
| Path | Description |
|------|-------------|
| `/ws` | Real-time dashboard updates (5s interval) |

## ⚙️ Configuration

### config.json Structure

```json
{
  "admin_token": "your-secure-token",
  "providers": {
    "provider_name": {
      "display": "My Provider",
      "enabled": true,
      "base_url": "https://api.provider.com/v1",
      "api_key": "sk-xxx",
      "weight": 1
    }
  },
  "models": [
    {
      "name": "model-name",
      "provider": "provider_name",
      "tier": 0,
      "enabled": true
    }
  ],
  "routing": {
    "tier_weights": { "0": 40, "1": 45, "2": 15 },
    "max_retries": 4,
    "cooldown_seconds": 30
  },
  "guardrails": {
    "enabled": true
  }
}
```

### Tier Weights
- **Tier 0** (40%) — Fastest, most reliable models
- **Tier 1** (45%) — Balanced performance/cost
- **Tier 2+** (15%) — Fallback/backup providers

When a provider returns 429 (rate limited) or 5xx, the router automatically moves to the next model/provider in the tier. After 3 consecutive failures, the provider enters cooldown.

## 🖥️ Dashboard

The built-in dashboard provides:

- **Overview**: KPIs, success rate, request volume, latency trends
- **Models**: Model pool management with usage stats
- **Providers**: Provider health and configuration
- **Routes**: Tier weight and routing configuration
- **Keys**: API key management
- **Cost**: Daily/monthly cost breakdown by model
- **Guardrails**: Content filter logs
- **Topology**: Interactive provider-model graph
- **System**: Config viewer and hot reload

## 🧪 Example: Use with OpenAI SDK

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:7878/v1',
  apiKey: 'any-key',  // or your configured admin_token
});

const stream = await client.chat.completions.create({
  model: 'any-model-name',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
});
```

## 🛠️ Development

```bash
# Watch mode (auto-restart on file changes)
node --watch src/index.js
```

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing`)
5. Open a Pull Request

## 📄 License

MIT — see [LICENSE](LICENSE)

## 🙏 Acknowledgments

Built with ❤️ for the AI developer community. Inspired by the need for intelligent, cost-effective LLM routing.
