'use client';

type PolymarketEmbedProps = {
  marketSlug: string;
  title: string;
  url: string;
  summary?: string;
  border?: boolean;
  liveActivity?: boolean;
  creator?: string;
  height?: number;
  width?: number;
};

export function PolymarketEmbed({
  marketSlug,
  title,
  url,
  summary,
  border = false,
  liveActivity = true,
  creator,
  height = 300,
  width = 400,
}: PolymarketEmbedProps) {
  const params = new URLSearchParams();
  params.set('market', marketSlug);
  params.set('theme', 'dark');
  if (liveActivity) params.set('liveactivity', 'true');
  if (border) params.set('border', 'true');
  if (creator) params.set('creator', creator);
  params.set('height', String(height));

  const iframeSrc = `https://embed.polymarket.com/market?${params.toString()}`;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: title,
    description: summary ?? `Prediction market on Polymarket.`,
    url,
    publisher: {
      '@type': 'Organization',
      name: 'Polymarket',
      url: 'https://polymarket.com',
    },
  };

  return (
    <figure
      className="polymarket-embed"
      id={`polymarket-${marketSlug}`}
      aria-label={`Polymarket prediction market: ${title}`}
      itemScope
      itemType="https://schema.org/WebPage"
      style={{ position: 'relative', display: 'inline-block', margin: 0 }}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <iframe
        title={`${title} — Polymarket Prediction Market`}
        src={iframeSrc}
        width={width}
        height={height}
        frameBorder="0"
        allowTransparency
      />
      <a
        href={url}
        aria-label="View on Polymarket"
        target="_blank"
        rel="noopener"
        style={{
          position: 'absolute',
          top: 16,
          right: 20,
          width: 120,
          height: 24,
          zIndex: 10,
        }}
      />
      <figcaption
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        <strong>{title}</strong>
        <br />
        {summary}
        <br />
        <a href={url}>View full market &amp; trade on Polymarket</a>
      </figcaption>
    </figure>
  );
}
