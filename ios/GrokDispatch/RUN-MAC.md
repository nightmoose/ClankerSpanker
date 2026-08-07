# ClankerSpanker — Mac only (for now)

## Do this

1. Open **`ClankerSpanker.xcodeproj`** (this folder).
2. Scheme should say **`ClankerSpanker`**.
3. Destination must be **`My Mac`** — **not** “Designed for iPad”.
4. Run (⌘R).

Or from terminal:

```bash
cd ~/Projects/GrokDispatch/ios/GrokDispatch
./run-mac.sh
```

## What you should see

- Sidebar: session list  
- Detail: transcript + **message box at the top**  
- Toolbar: New Task, Host, Settings  
- **Not** phone tabs `Sessions | Dispatch | Settings`

## If Xcode still says “Designed for iPad”

That means an old **iPhone** scheme is selected. This project no longer ships a phone Run scheme.

- Product → Scheme → **ClankerSpanker**
- Destination → **My Mac**
- Product → Clean Build Folder, then Run

## Phone app

Still in the project as target `ClankerSpanker` (iOS) for later. It is **not** wired to a scheme until we deliberately bring phone work back.
