// Build the client half in the DSH `window.__ModuleLoader__.load` wrapper format.
// The server concatenates raw client bundle bytes into a classic-script batch, so
// a bare ESM `import` breaks the whole batch (SyntaxError -> "Failed to load
// plugins"). Official and third-party client bundles are wrapped like this:
//
//   window.__ModuleLoader__.load({ id, factory: (require) => { ...CJS... } })
//
// The factory's `require` shim resolves externals (react, @deepseek-ai/*).
import { build } from 'esbuild'
import { writeFileSync } from 'node:fs'

const result = await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  external: ['react', '@deepseek-ai/*'],
  loader: { '.css': 'text' },
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
console.log(`lib/client.js written (${wrapped.length} bytes, wrapped in __ModuleLoader__.load)`)
