# Sheet Image Preview

Chrome extension for Google Sheets that detects image cells and shows a preview overlay.

## Features
- Preview images inside Google Sheets without leaving the sheet.
- Copy image URL to clipboard.
- Open original image in a new tab.
- Download the image with a smart filename.
- Soft overlay indicator around image cells with hover feedback.
- Settings for overlay, preview toolbar, and indicator timing.

## Installation (manual)
1. Open `chrome://extensions` in Chrome.
2. Enable `Developer mode` in the top right.
3. Click `Load unpacked`.
4. Select this `shp6` folder.

## Usage
- Open a Google Sheets document.
- The extension detects image cells and draws a preview border.
- Hover over a detected image area to reveal sharper feedback.
- Click the image cell to open the preview modal.
- Use the preview toolbar to copy, open, or download the image.

## Settings
Open the extension options page to:
- Enable or disable the overlay indicator.
- Show or hide the `Open original` toolbar button.
- Adjust fresh TTL and seen TTL values.
- Set the overlay camera icon size.

## Development
- Run `npm test` to execute tests.
- Edit `ui.js`, `hook.js`, `bg.js`, or `options.js` and reload the unpacked extension.

## Notes
- Chrome Web Store publishing requires a one-time developer registration fee.
- Manual install via `Load unpacked` is the simplest free option.
