"""Build the project's small, flat browser/bridge mark at toolbar sizes."""
from pathlib import Path
from PIL import Image, ImageDraw


def main():
    folder = Path(__file__).resolve().parents[1] / "WS Browser Bridge" / "icon"
    folder.mkdir(exist_ok=True)
    image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((32, 32, 480, 480), radius=96, fill="#157f78")
    draw.rounded_rectangle((104, 122, 408, 390), radius=28, outline="white", width=24)
    draw.line((116, 190, 396, 190), fill="white", width=20)
    for x in (145, 178, 211):
        draw.ellipse((x - 7, 151, x + 7, 165), fill="white")
    draw.arc((145, 239, 281, 333), 80, 280, fill="white", width=24)
    draw.arc((231, 239, 367, 333), 260, 460, fill="white", width=24)
    draw.line((213, 286, 299, 286), fill="white", width=24)
    for size in (16, 32, 48, 128, 256):
        image.resize((size, size), Image.Resampling.LANCZOS).save(folder / f"bridge-{size}.png")
    image.save(folder / "bridge.ico", sizes=[(16, 16), (32, 32), (48, 48), (128, 128), (256, 256)])
    placeholder = Image.new("RGBA", (144, 144), (0, 0, 0, 0))
    person = ImageDraw.Draw(placeholder)
    person.ellipse((0, 0, 143, 143), fill="#e9eff0")
    person.ellipse((47, 28, 97, 78), fill="#849b9e")
    person.ellipse((28, 87, 116, 156), fill="#849b9e")
    placeholder.resize((36, 36), Image.Resampling.LANCZOS).save(folder / "avatar-placeholder.png")


if __name__ == "__main__":
    main()
