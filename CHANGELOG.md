# Changelog

## Unreleased

- Fixed the Firefox extension skipping plain text in articles that use divs for paragraphs.
- The extension popup's resume button now resumes instead of pausing again.
- The extension popup shows playback state and controls straight away instead of after its server
  checks.
- The extension stops reading when the source tab is closed or navigates to a new page.
- The extension marks the tab being read with a ▶ badge; the popup names that tab and offers a
  "Go to tab" button.
- Fixed an old or stopped read in the extension taking over playback or state from a newer read.
- The extension's direct target defaults to `https://api.openai.com`, reports a rejected API key
  as invalid, and has a Show API key toggle in the options.
- The extension rejects PDFs in direct mode and hides the backend URL setting there.
- The extension popup footer names the TTS target and notes when highlighting is approximate.
- Added a Docker quickstart to the README.
