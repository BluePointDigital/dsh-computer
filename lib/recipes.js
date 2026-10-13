/** Small tested recipe catalog, not a remote marketplace. */
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
]

export function recipePlan(id) {
  const recipe = recipes.find((item) => item.id === id)
  if (!recipe) throw new Error('Unknown application recipe')
  const { notes, ...plan } = recipe
  return structuredClone(plan)
}
