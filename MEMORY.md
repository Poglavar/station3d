# Project memory

- Station3D is the temporary name for a reusable travel and game engine powered by OpenStreetMap and other open data.
- Downstream products consume exact Station3D versions at build time; Zagreb Prijevoz is the reference integration during the alpha period.
- Reusable world behavior stays in Station3D; Zagreb applications retain regional providers, host integration and authored campaign content.
- Original engine code and creator-authored vehicle models, including the reusable HŽ 7022, TMK 2400 and UTVA models, are MIT licensed; third-party audio retains its recorded terms.
- The public repository starts from a clean extraction snapshot without inherited commits, authored campaign content or automation attribution.
- Browser consumers receive a self-contained built directory through npm and vendor it into their own public tree.
