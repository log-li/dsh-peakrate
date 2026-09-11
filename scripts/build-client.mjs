// Build the client half in the DSH `window.__ModuleLoader__.load` wrapper format.
// The server concatenates raw client bundle bytes into a classic-script batch, so
// a bare ESM `import` breaks the whole batch (SyntaxError -> "Failed to load
// plugins"). Official and third-party client bundles are wrapped like this:
//
//   window.__ModuleLoader__.load({ id, factory: (require) => { ...CJS... } })
//
// The factory's `require` shim resolves externals (react, @deepseek-ai/*).
//
// The client half cannot reach the host's cordis services (host tree and client
// tree are separate instances), so the profile snapshot is injected here at
// build time as a `define` constant and baked into the bundle.
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'

// Inject the same snapshot the host half ships (data/pricing.json), validated
// with the shared parser so the client sees exactly the host's shape.
const raw = JSON.parse(readFileSync('data/pricing.json', 'utf8'))

// Validate via esbuild's own transform pipeline (catalog.ts is TypeScript, so it
// cannot be imported by plain node). Bundling it here also keeps a single
// source of truth for the validation rules.
const catalogBundle = await build({
  entryPoints: ['src/catalog.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const catalogMod = await import(
  `data:text/javascript;base64,${Buffer.from(catalogBundle.outputFiles[0].text).toString('base64')}`
)
const parsed = catalogMod.parseCatalog(raw)
if (parsed === undefined) {
  throw new Error('data/pricing.json failed validation — refusing to build client')
}

const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  // 与官方 client 的 require 清单对齐：react / react-dom / jsx-runtime / primitives
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/*'],
  loader: { '.css': 'text' },
  define: {
    __PEAKRATE_PROFILES__: JSON.stringify(parsed.profiles),
  },
  write: false,
})
const code = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-peakrate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${code}
		return module.exports;
	}
});
`
writeFileSync('lib/client.js', wrapped)
console.log(
  `lib/client.js written (${wrapped.length} bytes, ${parsed.profiles.length} profiles baked in)`,
)
