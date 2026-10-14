/** Small tested recipe catalog, not a remote marketplace. */
// Images are pinned by digest once the image has actually been pulled and
// inspected here, because the review step is only meaningful if the bytes are
// fixed. Ports and volume targets below are measured from the images' own
// metadata (`docker image inspect`), not copied from documentation — the
// installer refuses a plan that does not include every directory the image
// declares as a volume, so a guessed target is a failed install.
//
// These five exist because an agent and a human need somewhere to work together:
// code-server for editing the same files, File Browser for reviewing what was
// produced, Focalboard for work items, IT Tools for the small utilities, and
// Excalidraw for sketches that are easier to draw than to describe.
//
// Deliberately absent: Kanboard. It declares /etc/nginx/ssl as a volume, the
// installer requires every declared volume to be in the plan, and the validator
// refuses data volumes that mask system directories — so it cannot install under
// these rules at all. test/recipes.test.mjs is what makes that visible.
export const recipes = [
  {
    id: 'web-echo', name: 'HTTP Echo', description: 'A tiny request inspector for checking that the embedded app mount works.',
    image: 'traefik/whoami:v1.11.0', webPort: 80, cpus: 1, memoryMb: 128,
    notes: 'No persistent data. Useful as a first-install connection check.',
  },
  {
    id: 'web-static', name: 'Nginx', description: 'A small static web server with an embedded welcome page.',
    image: 'nginx:1.28-alpine', webPort: 80, cpus: 1, memoryMb: 128,
    notes: 'Stock welcome page; advanced installs can mount a named data volume for site content.',
  },
  {
    id: 'my-desktop', name: 'Linux Desktop', description: 'Debian desktop with Chromium and a shared embedded noVNC viewer.',
    image: 'dsh-computer:bookworm', webPort: 6080, viewer: true, cpus: 2, memoryMb: 4096, shmMb: 1024,
    volumes: [{ target: '/home/agent' }], localImage: true,
    notes: 'Requires the locally built computer image. Does not pull a similarly named public image. Home data is kept when uninstalled.',
  },
  {
    id: 'code-server', name: 'Code Server', description: 'VS Code in the browser, on a persistent home directory — the human and the agent edit the same files.',
    image: 'codercom/code-server@sha256:72ab24b5680ee597dd647b30d82625752f40109b5f61bef90ffbf1ea1f02dbb8',
    webPort: 8080, cpus: 2, memoryMb: 2048,
    volumes: [{ target: '/home/coder' }], env: { PASSWORD: '' },
    notes: '1.07 GB image. It asks for a PASSWORD value when you review the install; the value goes to private app storage, never to a plan summary. The editor sees the app volume, not this harness workspace.',
  },
  {
    id: 'filebrowser', name: 'File Browser', description: 'Browse, preview and download what an app keeps in its data volume — the review surface for files an agent produced.',
    image: 'filebrowser/filebrowser@sha256:a469ea076d4a1b4b1d86a41d130f2f536cd9da996a2b1fb39c0d7635f9d89b9a',
    webPort: 80, cpus: 1, memoryMb: 256,
    volumes: [{ target: '/config' }, { target: '/database' }, { target: '/srv' }],
    notes: 'The first start prints a generated admin password in the app log — open Logs after it starts. Files served come from /srv in its own volume.',
  },
  {
    id: 'it-tools', name: 'IT Tools', description: 'A battery of small developer utilities — hashes, encoders, converters, generators — on one page.',
    image: 'corentinth/it-tools@sha256:8b8128748339583ca951af03dfe02a9a4d7363f61a216226fc28030731a5a61f',
    webPort: 80, cpus: 1, memoryMb: 256,
    notes: 'Stateless and small. A good second app for confirming the mount serves a real single-page app with its own assets.',
  },
  {
    id: 'focalboard', name: 'Focalboard', description: 'A self-hosted kanban board on SQLite: work items the agent files, reviewed and moved by the human.',
    image: 'mattermost/focalboard@sha256:337346b132a7c1bd988b5fea59a9050ade42b9855399b0add5f95cf8f99ba800',
    webPort: 8000, cpus: 1, memoryMb: 512,
    volumes: [{ target: '/opt/focalboard/data' }],
    notes: 'Create the first admin account in the browser on first run. Board data lives in its own named volume and survives uninstall.',
  },
  {
    id: 'excalidraw', name: 'Excalidraw', description: 'A hand-drawn-style diagram board for architecture and flow sketches that pass back and forth between agent and human.',
    image: 'excalidraw/excalidraw@sha256:f7ee194addd607bf831d2af0f0a34463dd4225e426cf35199ef0b12a803398e9',
    webPort: 80, cpus: 1, memoryMb: 384,
    notes: 'Stateless: diagrams live in the browser until exported. Export a file to hand a sketch to the agent.',
  },
]

export function recipePlan(id) {
  const recipe = recipes.find((item) => item.id === id)
  if (!recipe) throw new Error('Unknown application recipe')
  const { notes, ...plan } = recipe
  return structuredClone(plan)
}
