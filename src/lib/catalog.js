/**
 * Curated starter catalogue.
 *
 * Every entry has been verified to resolve through yt-dlp and to have a
 * thumbnail. They are Blender Foundation films (CC-BY) and similar open
 * material: short enough to iterate on while developing, and licenced so
 * streaming them as a demo is unambiguous.
 *
 * Ids are plain data - edit freely, then run `npm run catalog:verify` to
 * re-check that each one still resolves and has artwork.
 */
export const catalog = Object.freeze([
  {
    id: 'aqz-KE-bpKQ',
    title: 'Big Buck Bunny',
    subtitle: 'Blender Foundation - CC-BY',
    duration: '10:35',
    tags: ['animation', 'open movie', '4K'],
  },
  {
    id: 'eRsGyueVLvQ',
    title: 'Sintel',
    subtitle: 'Blender Foundation - CC-BY',
    duration: '14:48',
    tags: ['animation', 'open movie', 'fantasy'],
  },
  {
    id: 'R6MlUcmOul8',
    title: 'Tears of Steel',
    subtitle: 'Blender Foundation - CC-BY',
    duration: '12:15',
    tags: ['animation', 'sci-fi', 'vfx'],
  },
  {
    id: 'wEUySRwbuU8',
    title: 'Spring',
    subtitle: 'Blender Foundation - CC-BY',
    duration: '8:20',
    tags: ['animation', 'open movie', 'nature'],
  },
  {
    id: 'UXqq0ZvbOnk',
    title: 'Charge',
    subtitle: 'Blender Foundation - CC-BY',
    duration: '4:23',
    tags: ['animation', 'open movie', 'short'],
  },
  {
    id: 'TLkA0RELQ1g',
    title: 'Elephants Dream',
    subtitle: 'Blender Foundation - CC-BY',
    duration: '10:55',
    tags: ['animation', 'open movie', 'surreal'],
  },
  {
    id: 'ftlvreFtA2A',
    title: 'Flying over Norway',
    subtitle: 'Scenic 4K drone film',
    duration: '57:28',
    tags: ['travel', 'nature', '4K'],
  },
  {
    id: 'D48T0wNm96w',
    title: 'Japan, scenic relaxation',
    subtitle: 'Calming 4K film',
    duration: '1:00:29',
    tags: ['travel', 'japan', '4K'],
  },
]);

/**
 * The "TRY DEMO" button: a short, universally available clip so the UI can
 * demonstrate a live stream without any user input.
 */
export const DEMO = Object.freeze({
  url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  title: 'Demo - Big Buck Bunny',
});

/**
 * Deduplicates by id while preserving order, and stamps `url`/`thumb` so the
 * frontend never has to build YouTube URLs itself.
 */
export function catalogPayload() {
  const seen = new Set();
  const items = [];
  for (const entry of catalog) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    items.push({
      ...entry,
      url: `https://www.youtube.com/watch?v=${entry.id}`,
      thumb: `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
    });
  }
  return {
    demo: { ...DEMO, thumb: `https://i.ytimg.com/vi/${new URL(DEMO.url).searchParams.get('v')}/mqdefault.jpg` },
    items,
  };
}
