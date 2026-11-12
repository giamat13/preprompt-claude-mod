# preprompt

A Claude Code mod. Before each prompt is sent, a model one tier below the one you use asks you a few questions, then writes the real prompt, in great detail, and sends that instead.

## How it works

1. You type `/preprompt <your prompt>`. Prompts typed without it are left alone.
2. A helper model one tier below your session model reads it: fable uses opus, opus uses sonnet, sonnet uses haiku.
3. It asks up to 4 short questions, only where the answer would change the result. Skip any you like.
4. It writes the final prompt in your language and keeps all your facts. The detail matches the task: short for a small one, structured for a big one, never padded.
5. That prompt is sent. If anything fails, your original prompt is sent as typed.

The mod runs only when you type `/preprompt`.

## Install

Needs a Claude Code version that supports mods (2.1.287 or newer in the terminal).

```
/plugin marketplace add GIAMAT13/preprompt-claude-mod
/plugin install preprompt@preprompt-mods
/reload-plugins
```

## Limits

- The helper model sees only your prompt, not the chat history.
- The detailed prompt is sent right away; you do not review it first.

Inspired by the Ben AI mods pack (brain-dump). No code is copied from it.

## License

MIT, see [LICENSE](LICENSE).
