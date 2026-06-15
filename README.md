# OpenUsage Plugin Hub

Standalone plugin registry for [OpenUsage](https://github.com/robinebers/openusage).

Add this repo as a source in OpenUsage's Plugin Hub:
```
https://github.com/FrankieeW/openusage-plugin-hub
```

## Plugin Schema

Each plugin lives in `plugins/<id>/` with:
- `plugin.json` — manifest (schema v1)
- `plugin.js` — entry script (`globalThis.__openusage_plugin`)
- `icon.svg` — provider icon

## Publishing a plugin

1. Fork this repo
2. Add your plugin under `plugins/<id>/`
3. Ensure `plugin.json` validates: `schemaVersion: 1`, `id` matches directory name
4. Open a PR

## License

Apache 2.0 (inherited from upstream openusage)
