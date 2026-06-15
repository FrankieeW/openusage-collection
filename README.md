# OpenUsage Collection

Community plugin collection for [OpenUsage.cc](https://github.com/FrankieeW/openusage).

```
https://github.com/FrankieeW/openusage-collection
```

## Plugin Schema

Each plugin lives in `plugins/<id>/` with:
- `plugin.json` — manifest (schema v1)
- `plugin.js` — entry script (`globalThis.__openusage_plugin`)
- `icon.svg` — provider icon

## Publishing

1. Fork this repo
2. Add your plugin under `plugins/<id>/`
3. `plugin.json`: `schemaVersion: 1`, `id` matches directory name
4. Open a PR

## License

Apache 2.0 (inherited from upstream openusage)
