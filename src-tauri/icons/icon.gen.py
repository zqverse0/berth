"""Render the Berth icons from their SVG sources.

    python3 src-tauri/icons/icon.gen.py            # icon.svg -> icon.png (1024), tray-icon.svg -> tray-icon-template.png
    pnpm tauri icon src-tauri/icons/icon.png -o /tmp/icons   # then copy the sizes you need

icon.svg is the app icon: a paper-cut boat with three sails (three agents
sharing one berth) on a warm cream tile. tray-icon.svg is the same boat as a
single-colour silhouette for the macOS menu bar (the system tints the alpha).
Needs Playwright with a system Chrome; Pillow for the tray resize.
"""

import asyncio
from pathlib import Path

from PIL import Image
from playwright.async_api import async_playwright

HERE = Path(__file__).parent
CHROME = "/usr/bin/google-chrome"


async def render(svg: Path, png: Path, size: int) -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        page = await browser.new_page(viewport={"width": size, "height": size})
        await page.set_content(
            f"<style>html,body{{margin:0;background:transparent}}"
            f"svg{{width:{size}px;height:{size}px;display:block}}</style>{svg.read_text()}"
        )
        await page.screenshot(path=str(png), omit_background=True)
        await browser.close()


def tray_template(src: Path, dst: Path, size: int = 44) -> None:
    big = HERE / "_tray-big.png"
    asyncio.run(render(src, big, size * 8))
    m = Image.open(big).convert("RGBA")
    m = m.crop(m.getbbox())
    scale = size * 0.9 / max(m.size)
    m = m.resize((round(m.width * scale), round(m.height * scale)), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(m, ((size - m.width) // 2, (size - m.height) // 2), m)
    canvas.save(dst)
    big.unlink()


if __name__ == "__main__":
    asyncio.run(render(HERE / "icon.svg", HERE / "icon.png", 1024))
    tray_template(HERE / "tray-icon.svg", HERE / "tray-icon-template.png")
    print("wrote icon.png, tray-icon-template.png")
