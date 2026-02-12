[日本語版](../concept.md)

# CommandMate - Concept

## A Parallel Development Platform for Vibe Coders

> **"Work, parenting, chores. Weaving code in the gaps between them all."**

---

## The Problem This Tool Solves

### The Reality of Vibe Coding

The advent of AI coding assistants (such as Claude Code) has fundamentally changed the way we develop. So-called "Vibe Coding" - an intuitive style of writing code through conversation with AI - has opened up new possibilities for many developers.

However, terminal-only development has its limitations:

- **Location-bound**: You can't develop unless you're sitting at your PC
- **Time-consuming**: You need a large block of time to start working
- **Context switch cost**: Focusing on one task means other tasks stall
- **Hard to balance with life**: No room to develop between work, parenting, and household chores

### Our Answer

CommandMate is our answer to these challenges:

```
🚀 Parallel Development × 📱 Mobile Access × 📦 All in One App = ∞ Productivity
```

No need to switch between multiple tools. **With just a browser, you can give instructions, check execution results, and manage history - all in one place.**

---

## Concept

### 1. Independent Development Environments per Branch

Leveraging the Git worktree concept, CommandMate manages **independent AI sessions for each branch**.

```
feature/authentication  →  Claude Code Session A
feature/dashboard       →  Claude Code Session B
bugfix/login-error      →  Claude Code Session C
```

This enables:
- **Parallel task processing**: You can start work on another branch while AI is still working
- **Context preservation**: Conversation history for each branch is stored independently
- **Flexible work style**: Switch between tasks based on your mood or situation

### 2. Development from Your Smartphone

**Being able to move development forward without a PC** - this is the core of CommandMate.

- Give PR review instructions while on your commute
- Request a bug fix while the kids are napping
- Check test results between household chores

With a mobile-optimized UI, you can **convert idle moments into development time**.

### 3. Asynchronous & Event-Driven

No need to wait for AI responses.

1. Give a task instruction from your phone
2. Put it back in your pocket and go about your day
3. Get notified when AI completes the task
4. Check the results and give the next instruction

This cycle lets you **use AI processing time as living time**.

---

## Target Users

CommandMate is ideal for:

### 👨‍👩‍👧‍👦 Engineers with Kids

> "I can't get large blocks of time, but I have 5-10 minute gaps throughout the day."

You can make progress by accumulating short bursts of time while kids are playing, napping, or after bedtime.

### 👔 Side-Project Developers with Day Jobs

> "Weekdays are for work, weekends are for family. But I still want to advance my own project."

Use commute time, lunch breaks, and waiting time to develop without affecting your day job.

### 🏠 Remote Workers

> "It's hard to focus at home. Switching between chores is stressful."

Toss tasks at AI between chores and check the results when you're done. Develop without disrupting your daily rhythm.

### 🌟 Vibe Coders

> "Developing through conversation with AI is fun. But being glued to the terminal is tiring."

With a chat-style UI, you can collaborate with AI more naturally.

---

## Productivity Gains

### Before: Traditional Development Style

```
[PC Work] ━━━━━━━━━━━━━━━━━━━━━━━━━━━
          ↑                            ↑
       Start dev                    End dev
       (Need 2 hours of focused time)
```

### After: CommandMate Style

```
[Commute] [Work] [Lunch] [Work] [Home] [Chores] [Kids] [Bedtime]
   📱      💼     📱      💼     🚃      🏠       👶      📱
   ↑              ↑                              ↑        ↑
Task inst.  Check results          Check results  Review
 (3 min)     (5 min)              while parenting (10 min)
                                     (2 min)
```

**The sum of distributed idle moments can yield results equivalent to a solid block of development time.**

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Multi-Worktree Management** | Independent AI sessions per branch |
| **Mobile-Optimized UI** | Chat interface optimized for touch |
| **Real-Time Status** | Instantly see AI state (processing/waiting/complete) |
| **CLI Support** | Claude Code, Codex CLI |
| **Log Management** | Detailed conversation history saved in Markdown |
| **LAN Access** | Accessible from smartphones on the same network |

---

## Tech Stack

- **Frontend**: Next.js 14 (App Router) / TypeScript / Tailwind CSS
- **Backend**: Next.js API Routes / Node.js
- **Database**: SQLite
- **Session Management**: tmux
- **Real-Time Communication**: WebSocket
- **Supported CLIs**: Claude Code, Codex CLI

---

## Getting Started

```bash
# Install
git clone https://github.com/Kewton/CommandMate.git
cd CommandMate
npm install

# Configure (.env)
CM_ROOT_DIR=/path/to/your/repos
CM_BIND=0.0.0.0
# External access: configure reverse proxy authentication (see docs/security-guide.md)

# Start
npm run build && npm start
```

Access `http://<your-pc-ip>:3000` from your phone's browser to get started.

For more details, see [README.md](../../README.md).

---

## License

MIT License

This project is open-sourced for all developers who want to make progress during their idle moments.

---

## In Closing

> **"Development is a part of life, not all of it."**

CommandMate is a tool for achieving harmony between development and life.

Even if you have a job, a family, hobbies. You can cherish all of them while continuing to develop at your own pace.

That is the Vibe Coding lifestyle we aspire to.

---

*Built with ❤️ for Vibe Coders everywhere*
