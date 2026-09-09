//! Image transforms — crop, rotate, flip, resize and a change of format.
//!
//! **Why this is in Rust and not in the page.** A canvas would have been fewer
//! lines, and it was the wrong instrument twice over: a photograph out of a
//! phone is forty megapixels, which is a hundred and sixty megabytes of RGBA in
//! the JS heap before anything is done to it, and every browser draws the
//! encoder's quality knob differently. Here the same code serves the desktop and
//! the phone, and the bytes never enter the webview at all — the page sends a
//! plan and gets dimensions back.
//!
//! **The order of operations is fixed**, because the same four asked in a
//! different order give different pictures: orientation, then rotate, then flip,
//! then crop, then resize.
//!
//! Turning before cropping is the order that costs the page nothing. A crop
//! arrives as a rectangle somebody dragged over what was on their screen — and
//! what was on their screen was already turned. Cropping first would mean the
//! page had to map that rectangle back through its own rotation before sending
//! it, which is arithmetic in the one place where a mistake is invisible: the
//! picture would simply come out cropped somewhere else. This way the rectangle
//! means what it looks like.
//!
//! **Orientation is baked in.** A photograph out of a phone is usually stored
//! sideways with an Exif tag saying which way is up, and every viewer obeys the
//! tag. Nothing here writes Exif back — so a re-encode that ignored it would
//! turn every phone photograph on its side, and the one place that must never
//! happen is a program whose whole promise is that it does not damage documents.
//! The rotation the tag asks for is therefore applied to the pixels, and the tag
//! is not needed afterwards.
//!
//! **What it costs is returned rather than assumed.** Re-encoding a JPEG loses
//! something even if nothing was changed, because the format is lossy going in
//! and coming out; a PNG re-encode loses nothing. The caller is told which of
//! the two it is asking for, so it can say so before the file is written.

use std::io::Cursor;
use std::path::Path;

use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ImageError {
    #[error("the format of this image is not one that can be written: {0}")]
    UnsupportedFormat(String),
    #[error("the image could not be read: {0}")]
    Decode(String),
    #[error("the image could not be written: {0}")]
    Encode(String),
    /// A crop that lies wholly or partly outside the picture.
    #[error("the crop is outside the image: {0}")]
    Crop(String),
    #[error("a size of zero has no picture in it")]
    EmptySize,
    #[error("file system error: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for ImageError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// The formats that can be written back. Reading knows more than this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Encoding {
    Png,
    Jpeg,
    Webp,
    Bmp,
    Tiff,
}

impl Encoding {
    /// Whether writing this format throws information away by itself.
    ///
    /// WebP is the awkward one: the format has both a lossy and a lossless
    /// mode, and `image` writes it losslessly — so it belongs with PNG here,
    /// and would belong with JPEG in a build that encoded it the other way.
    pub fn lossy(self) -> bool {
        matches!(self, Encoding::Jpeg)
    }

    pub fn extension(self) -> &'static str {
        match self {
            Encoding::Png => "png",
            Encoding::Jpeg => "jpg",
            Encoding::Webp => "webp",
            Encoding::Bmp => "bmp",
            Encoding::Tiff => "tiff",
        }
    }

    fn format(self) -> ImageFormat {
        match self {
            Encoding::Png => ImageFormat::Png,
            Encoding::Jpeg => ImageFormat::Jpeg,
            Encoding::Webp => ImageFormat::WebP,
            Encoding::Bmp => ImageFormat::Bmp,
            Encoding::Tiff => ImageFormat::Tiff,
        }
    }

    fn from_format(format: ImageFormat) -> Option<Self> {
        match format {
            ImageFormat::Png => Some(Encoding::Png),
            ImageFormat::Jpeg => Some(Encoding::Jpeg),
            ImageFormat::WebP => Some(Encoding::Webp),
            ImageFormat::Bmp => Some(Encoding::Bmp),
            ImageFormat::Tiff => Some(Encoding::Tiff),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

/// What the page asked for. Every field absent is a picture written back as it
/// was — which is still a re-encode, and still says so.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Ops {
    /// Clockwise, in degrees. Anything other than 90, 180 or 270 is no rotation.
    pub rotate: u16,
    pub flip_horizontal: bool,
    pub flip_vertical: bool,
    pub crop: Option<Rect>,
    pub resize: Option<Size>,
    /// The format to write. Absent keeps the one the file already had.
    pub encoding: Option<Encoding>,
    /// 1–100, for the formats that have such a thing. Absent means 90.
    pub quality: Option<u8>,
}

impl Ops {
    /// Whether this plan would change any pixel at all.
    pub fn changes_anything(&self) -> bool {
        self.rotate % 360 != 0
            || self.flip_horizontal
            || self.flip_vertical
            || self.crop.is_some()
            || self.resize.is_some()
    }
}

/// What an image is, before anything is done to it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    /// The size as a person sees it — after the Exif orientation is applied.
    pub width: u32,
    pub height: u32,
    pub encoding: Option<Encoding>,
    /// Whether the file is stored sideways with a tag saying which way is up.
    pub reoriented: bool,
    /// Whether this image can be written back at all.
    pub editable: bool,
}

/// The result of a write: what the file now holds.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub width: u32,
    pub height: u32,
    pub encoding: Encoding,
    pub bytes: u64,
    /// Whether the encoding itself threw information away.
    pub lossy: bool,
}

fn guess(bytes: &[u8]) -> Option<ImageFormat> {
    image::guess_format(bytes).ok()
}

/// Reads the image and stands it upright.
///
/// Two passes over the bytes, and the second one is the picture: the decoder is
/// asked for the orientation first, since that is metadata and has to be read
/// before the pixels are handed over.
fn decode(bytes: &[u8]) -> Result<(DynamicImage, bool), ImageError> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|err| ImageError::Decode(err.to_string()))?;

    let mut decoder = reader
        .into_decoder()
        .map_err(|err| ImageError::Decode(err.to_string()))?;

    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);

    let mut image =
        DynamicImage::from_decoder(decoder).map_err(|err| ImageError::Decode(err.to_string()))?;

    let reoriented = orientation != Orientation::NoTransforms;
    if reoriented {
        image.apply_orientation(orientation);
    }
    Ok((image, reoriented))
}

/// What the file is, without transforming anything.
pub fn info(bytes: &[u8]) -> Result<Info, ImageError> {
    let format = guess(bytes);
    let (image, reoriented) = decode(bytes)?;
    let encoding = format.and_then(Encoding::from_format);
    Ok(Info {
        width: image.width(),
        height: image.height(),
        encoding,
        reoriented,
        editable: encoding.is_some(),
    })
}

/// Applies a plan and returns the encoded bytes.
pub fn apply(bytes: &[u8], ops: &Ops) -> Result<(Vec<u8>, Written), ImageError> {
    let source_format = guess(bytes);
    let encoding = match ops
        .encoding
        .or_else(|| source_format.and_then(Encoding::from_format))
    {
        Some(encoding) => encoding,
        None => {
            return Err(ImageError::UnsupportedFormat(
                source_format
                    .and_then(|f| f.extensions_str().first().copied())
                    .unwrap_or("unknown")
                    .to_string(),
            ))
        }
    };

    let (mut image, _) = decode(bytes)?;

    image = match ops.rotate % 360 {
        90 => image.rotate90(),
        180 => image.rotate180(),
        270 => image.rotate270(),
        _ => image,
    };

    if ops.flip_horizontal {
        image = image.fliph();
    }
    if ops.flip_vertical {
        image = image.flipv();
    }

    if let Some(rect) = ops.crop {
        if rect.width == 0 || rect.height == 0 {
            return Err(ImageError::EmptySize);
        }
        // The rectangle came from a drag over the picture on screen, so it is
        // checked against the picture rather than trusted: a crop that runs off
        // the edge would otherwise be silently clamped, and the person would get
        // a different rectangle than the one they drew.
        if rect.x + rect.width > image.width() || rect.y + rect.height > image.height() {
            return Err(ImageError::Crop(format!(
                "{}×{} at {},{} does not fit in {}×{}",
                rect.width,
                rect.height,
                rect.x,
                rect.y,
                image.width(),
                image.height()
            )));
        }
        image = image.crop_imm(rect.x, rect.y, rect.width, rect.height);
    }

    if let Some(size) = ops.resize {
        if size.width == 0 || size.height == 0 {
            return Err(ImageError::EmptySize);
        }
        // Lanczos3 rather than the cheaper filters: this is a photograph being
        // made smaller, which is the case where a nearest-neighbour resize is
        // visibly worse and nobody can say why.
        image = image.resize_exact(size.width, size.height, FilterType::Lanczos3);
    }

    // JPEG has no alpha, and an alpha channel handed to its encoder is an error
    // rather than a flattening. A transparent PNG saved as a JPEG therefore
    // arrives on white, which is what every other program does with it.
    if encoding == Encoding::Jpeg && image.color().has_alpha() {
        image = DynamicImage::ImageRgb8(flatten_onto_white(&image));
    }

    let mut out = Cursor::new(Vec::new());
    match encoding {
        Encoding::Jpeg => {
            let quality = ops.quality.unwrap_or(90).clamp(1, 100);
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
            encoder
                .encode_image(&image)
                .map_err(|err| ImageError::Encode(err.to_string()))?;
        }
        other => image
            .write_to(&mut out, other.format())
            .map_err(|err| ImageError::Encode(err.to_string()))?,
    }

    let bytes = out.into_inner();
    let written = Written {
        width: image.width(),
        height: image.height(),
        encoding,
        bytes: bytes.len() as u64,
        lossy: encoding.lossy(),
    };
    Ok((bytes, written))
}

/// Composites over white, for the formats that cannot carry transparency.
fn flatten_onto_white(image: &DynamicImage) -> image::RgbImage {
    let source = image.to_rgba8();
    let mut out = image::RgbImage::new(source.width(), source.height());
    for (x, y, pixel) in source.enumerate_pixels() {
        let [r, g, b, a] = pixel.0;
        let alpha = f32::from(a) / 255.0;
        let over = |channel: u8| {
            (f32::from(channel) * alpha + 255.0 * (1.0 - alpha))
                .round()
                .clamp(0.0, 255.0) as u8
        };
        out.put_pixel(x, y, image::Rgb([over(r), over(g), over(b)]));
    }
    out
}

/// Reads one file, applies a plan, writes another. The bytes never leave Rust.
pub fn write_file(source: &Path, target: &Path, ops: &Ops) -> Result<Written, ImageError> {
    let bytes = std::fs::read(source)?;
    let (out, written) = apply(&bytes, ops)?;
    std::fs::write(target, &out)?;
    Ok(written)
}

/// What a file is, read from disk.
pub fn info_file(source: &Path) -> Result<Info, ImageError> {
    info(&std::fs::read(source)?)
}

/// The encoding a name implies — for deciding what a "save as" is asking for.
pub fn encoding_for_name(name: &str) -> Option<Encoding> {
    let extension = name.rsplit('.').next()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some(Encoding::Png),
        "jpg" | "jpeg" => Some(Encoding::Jpeg),
        "webp" => Some(Encoding::Webp),
        "bmp" => Some(Encoding::Bmp),
        "tif" | "tiff" => Some(Encoding::Tiff),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A picture with a corner that can be told apart: red top-left, so a
    /// rotation that went the wrong way is visible rather than plausible.
    fn corner_png() -> Vec<u8> {
        let mut image = image::RgbaImage::from_pixel(4, 2, image::Rgba([255, 255, 255, 255]));
        image.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    fn pixel_at(bytes: &[u8], x: u32, y: u32) -> [u8; 4] {
        let image = image::load_from_memory(bytes).unwrap().to_rgba8();
        image.get_pixel(x, y).0
    }

    #[test]
    fn reads_what_it_is() {
        let info = info(&corner_png()).unwrap();
        assert_eq!((info.width, info.height), (4, 2));
        assert_eq!(info.encoding, Some(Encoding::Png));
        assert!(info.editable);
        assert!(!info.reoriented);
    }

    #[test]
    fn a_quarter_turn_swaps_the_sides() {
        let ops = Ops {
            rotate: 90,
            ..Default::default()
        };
        let (bytes, written) = apply(&corner_png(), &ops).unwrap();
        assert_eq!((written.width, written.height), (2, 4));
        // Clockwise: the top-left corner goes to the top-right.
        assert_eq!(pixel_at(&bytes, 1, 0), [255, 0, 0, 255]);
    }

    #[test]
    fn three_quarters_is_not_a_quarter_the_other_way_by_accident() {
        let (bytes, _) = apply(
            &corner_png(),
            &Ops {
                rotate: 270,
                ..Default::default()
            },
        )
        .unwrap();
        // Anticlockwise: the top-left corner goes to the bottom-left.
        assert_eq!(pixel_at(&bytes, 0, 3), [255, 0, 0, 255]);
    }

    #[test]
    fn a_flip_is_a_mirror_and_not_a_turn() {
        let (bytes, written) = apply(
            &corner_png(),
            &Ops {
                flip_horizontal: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((written.width, written.height), (4, 2));
        assert_eq!(pixel_at(&bytes, 3, 0), [255, 0, 0, 255]);
    }

    #[test]
    fn a_crop_takes_the_rectangle_it_was_given() {
        let (bytes, written) = apply(
            &corner_png(),
            &Ops {
                crop: Some(Rect {
                    x: 0,
                    y: 0,
                    width: 2,
                    height: 1,
                }),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((written.width, written.height), (2, 1));
        assert_eq!(pixel_at(&bytes, 0, 0), [255, 0, 0, 255]);
    }

    #[test]
    fn a_crop_off_the_edge_is_refused_rather_than_trimmed() {
        let error = apply(
            &corner_png(),
            &Ops {
                crop: Some(Rect {
                    x: 3,
                    y: 0,
                    width: 4,
                    height: 1,
                }),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(matches!(error, ImageError::Crop(_)), "{error}");
    }

    #[test]
    fn a_resize_lands_on_the_size_it_was_asked_for() {
        let (_, written) = apply(
            &corner_png(),
            &Ops {
                resize: Some(Size {
                    width: 8,
                    height: 4,
                }),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((written.width, written.height), (8, 4));
    }

    #[test]
    fn the_order_is_turn_then_crop_then_resize() {
        /* A 4×2 turned a quarter is 2×4; the crop is then a rectangle in *that*
        picture, which is the one the person was looking at — 2×1 off the top
        — and the resize is the last word: 8×4. Under the old order the same
        plan gave 4×8, which is how the two can be told apart. */
        let (bytes, written) = apply(
            &corner_png(),
            &Ops {
                rotate: 90,
                crop: Some(Rect {
                    x: 0,
                    y: 0,
                    width: 2,
                    height: 1,
                }),
                resize: Some(Size {
                    width: 8,
                    height: 4,
                }),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((written.width, written.height), (8, 4));
        // The red corner went to the top-right with the turn, and the crop kept it.
        assert_eq!(pixel_at(&bytes, 7, 0), [255, 0, 0, 255]);
    }

    #[test]
    fn a_crop_is_measured_on_the_turned_picture() {
        /* The whole point of the order: after a quarter turn a 4×2 is 2 wide, so
        a crop 2 wide fits — and would have been refused as outside the image
        if the crop had been taken first. */
        let (_, written) = apply(
            &corner_png(),
            &Ops {
                rotate: 90,
                crop: Some(Rect {
                    x: 0,
                    y: 0,
                    width: 2,
                    height: 4,
                }),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((written.width, written.height), (2, 4));
    }

    #[test]
    fn a_change_of_format_is_a_change_of_bytes() {
        let (bytes, written) = apply(
            &corner_png(),
            &Ops {
                encoding: Some(Encoding::Jpeg),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(written.encoding, Encoding::Jpeg);
        assert!(written.lossy);
        assert_eq!(image::guess_format(&bytes).unwrap(), ImageFormat::Jpeg);
    }

    #[test]
    fn transparency_saved_as_jpeg_lands_on_white() {
        /* Sixteen pixels square rather than two, and the pixel that gets looked
        at is the far corner: JPEG subsamples the colour channels, so a red
        pixel bleeds a few values into whatever is next to it, and in a 2×2
        picture everything is next to everything. */
        let mut image = image::RgbaImage::from_pixel(16, 16, image::Rgba([0, 0, 0, 0]));
        for (x, y) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
            image.put_pixel(x, y, image::Rgba([255, 0, 0, 255]));
        }
        let mut source = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut source, ImageFormat::Png)
            .unwrap();

        let (bytes, _) = apply(
            &source.into_inner(),
            &Ops {
                encoding: Some(Encoding::Jpeg),
                ..Default::default()
            },
        )
        .unwrap();

        let [r, g, b, _] = pixel_at(&bytes, 15, 15);
        assert!(r > 248 && g > 248 && b > 248, "{r},{g},{b}");
        // And the red is still red, so the flattening did not paint over it.
        let [red_r, red_g, red_b, _] = pixel_at(&bytes, 0, 0);
        assert!(
            red_r > 200 && red_g < 60 && red_b < 60,
            "{red_r},{red_g},{red_b}"
        );
    }

    #[test]
    fn png_is_written_without_loss_and_says_so() {
        let (_, written) = apply(&corner_png(), &Ops::default()).unwrap();
        assert_eq!(written.encoding, Encoding::Png);
        assert!(!written.lossy);
    }

    #[test]
    fn a_plan_that_changes_nothing_knows_it() {
        assert!(!Ops::default().changes_anything());
        assert!(!Ops {
            encoding: Some(Encoding::Png),
            quality: Some(50),
            ..Default::default()
        }
        .changes_anything());
        assert!(Ops {
            rotate: 180,
            ..Default::default()
        }
        .changes_anything());
    }

    #[test]
    fn a_name_decides_the_encoding_of_a_save_as() {
        assert_eq!(encoding_for_name("slika.PNG"), Some(Encoding::Png));
        assert_eq!(encoding_for_name("slika.jpeg"), Some(Encoding::Jpeg));
        assert_eq!(encoding_for_name("slika.tif"), Some(Encoding::Tiff));
        assert_eq!(encoding_for_name("slika.avif"), None);
        assert_eq!(encoding_for_name("slika"), None);
    }

    #[test]
    fn an_empty_size_is_refused() {
        let error = apply(
            &corner_png(),
            &Ops {
                resize: Some(Size {
                    width: 0,
                    height: 4,
                }),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(matches!(error, ImageError::EmptySize), "{error}");
    }

    #[test]
    fn something_that_is_not_an_image_is_reported_as_unreadable() {
        let error = info(b"this is not a picture at all").unwrap_err();
        assert!(matches!(error, ImageError::Decode(_)), "{error}");
    }
}
