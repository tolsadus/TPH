# Changelog

## [0.0.3] - 2026-05-28
### Fixed
- Show the correct currency for every Tesla market. Non-Euro markets
  (e.g. Japan ¥, Hong Kong HK$) previously displayed prices in EUR.
- Listings whose price fluctuated but returned to its starting value now
  show a neutral "↕" marker and read "back to start" instead of being
  hidden as "no change". The flat "TPH" badge is now reserved for
  listings seen only once.
- Detect locales with lowercase market codes (e.g. zh_hk) so badges
  appear on the Hong Kong site instead of silently falling back to US.

## [0.0.2] - 2026
- Extension icons, privacy policy page, per-condition scrape summary.
- Link to the full TPH price-history website.
