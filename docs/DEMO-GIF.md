# Recording the demo GIF (`docs/demo.gif`)

The README has a placeholder for a short GIF that shows Mac Health in action. This file describes exactly how to record it.

## What the GIF shows

1. Claude Desktop with the Mac Health extension installed (from the `.mcpb`).
2. A new chat. Type exactly: **Why is my Mac slow?**
3. Claude calls `diagnose_slowness` (the tool call may be visible, that is fine).
4. Claude's answer with the ranked likely causes. Stop when the answer is complete.

Length: about 10-20 seconds. No sound. No cuts in the middle of the answer (speeding up the waiting part is fine).

## Privacy: nothing personal may be visible

The GIF will be public. Before recording, check every frame for personal details:

- Record on a Mac where no personal values are visible, or use made-up/masked values. Never show a real user name, computer name, serial number, Apple ID, e-mail address, Wi-Fi name or home folder path.
- Use a clean Claude Desktop window: no chat history in the sidebar (or hide the sidebar), no account name or avatar visible.
- Hide the menu bar and Dock contents if they show anything personal (notifications, calendar, other apps).
- Process and app names in the answer can reveal what you run. If the answer names apps you do not want to show, quit them first or record again until the answer only contains neutral names. If needed, blur or mask them in the editor.
- Watch the result once more before saving, frame by frame at the end.

## Size and format

- File: `docs/demo.gif` (exactly this name, the README points to it).
- Width: 720-800 px (the README shows it at 720 px), 10-15 fps.
- File size: under about 5 MB so it loads quickly on GitHub.
- Crop to the Claude Desktop window only, not the whole screen.

## Tools

Any screen recorder works. Two simple options:

- **Kap** (free, macOS): select the Claude Desktop window, record, export as GIF at 720 px width and 12 fps.
- **Built-in screen recording + ffmpeg**: record with Cmd+Shift+5 ("Record Selected Portion"), which gives a `.mov` file. Then convert it (the file name is just an example):

  ```bash
  ffmpeg -i recording.mov -vf "fps=12,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 docs/demo.gif
  ```

## When the GIF is ready

1. Save it as `docs/demo.gif`.
2. In `README.md`, replace the HTML comment under "Demo" and the "Demo GIF coming soon" line with:

   ```html
   <p align="center"><img src="docs/demo.gif" width="720" alt="Asking Claude 'Why is my Mac slow?' and getting ranked causes"></p>
   ```

3. Keep the text example under it (it is useful for people who cannot see the GIF), or remove it if it says the same thing.
