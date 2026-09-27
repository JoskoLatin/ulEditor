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
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
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
    /// Past [`MOST_BYTES`], going in, coming out or on the way.
    #[error("the image is too large to edit: {0}")]
    TooLarge(String),
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

/// The most memory one picture may take, decoded or on its way through a
/// resize: 512 MiB, which is the `image` crate's own default and what the
/// desktop had before this was counted — about 130 megapixels of 8-bit RGBA,
/// half that at 16 bits a channel, a quarter as floating point.
///
/// In bytes, not pixels, because the file chooses both. The size is in the
/// header and so is the depth: a TIFF of two hundred bytes can declare
/// 10 000 × 10 000 pixels of 32-bit float RGBA, which is 1.6 GB before a pixel
/// is read, and a limit counted in pixels lets it through. On desktop an
/// allocation that fails aborts the editor; in a browser tab running this as
/// WebAssembly it kills the instance. So the decoder is opened with limits of
/// its own and asked what it will need before it is let at the pixels, a GIF
/// frame larger than its screen is held to the same allowance by the decoder,
/// and a resize is checked for what its passes allocate — the picture stays
/// viewable either way.
///
/// A TIFF is held to half of it: its strip buffer and the picture share the
/// budget, so a TIFF opens up to 256 MiB decoded — about 67 megapixels of RGBA.
///
/// What it does not hold: a progressive JPEG keeps its coefficients while it
/// decodes, and the JPEG and WebP decoders take no allocation limit from
/// `image`. Those two can reach up to about three times this at their peak —
/// twice for an ordinary 4:2:0 JPEG, three times for a progressive 4:4:4 one.
/// Bounded, and in a browser a worker that runs out is replaced — but not
/// this number.
pub const MOST_BYTES: u64 = 512 * 1024 * 1024;

/// No side longer than JPEG's own maximum. Strict, and passed to every
/// decoder, some of which would otherwise accept any width at all.
const LONGEST_SIDE: u32 = 65_535;

/// `imageops::resize` samples in `f32` RGBA: sixteen bytes a pixel, whatever
/// the picture's own depth.
const RESAMPLE_BYTES_PER_PIXEL: u64 = 16;

fn fits(what: &str, bytes: u64) -> Result<(), ImageError> {
    if bytes > MOST_BYTES {
        return Err(ImageError::TooLarge(format!(
            "{what} would take {} MB, and the most is {} MB",
            bytes / 1_000_000,
            MOST_BYTES / 1_000_000
        )));
    }
    Ok(())
}

/// A decoder's own refusal of a size is the same refusal as ours.
fn decoding(err: image::ImageError) -> ImageError {
    match err {
        image::ImageError::Limits(_) => ImageError::TooLarge(err.to_string()),
        other => ImageError::Decode(other.to_string()),
    }
}

/// Whether every chunk a WebP declares lies inside the file.
///
/// The WebP decoder reads a metadata chunk — the Exif that holds the
/// orientation, an ICC profile — by allocating the size the chunk declares
/// and then filling it, and `image` gives it no limit to check that size
/// against. A file of a hundred bytes can declare an Exif chunk of four
/// gigabytes. All the bytes are already in memory, so the honest bound is
/// the file itself: a chunk that claims more than is there is not read.
fn webp_chunks_fit(bytes: &[u8]) -> bool {
    let word = |at: usize| -> Option<usize> {
        let b = bytes.get(at..at + 4)?;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    // RIFF, its size, WEBP; then chunks of a fourcc, a size and the data,
    // padded to an even length.
    let Some(riff) = word(4) else { return false };
    if riff.saturating_add(8) > bytes.len() {
        return false;
    }
    // Only as far as the RIFF says the file goes, which is as far as the
    // decoder reads: whatever trails it is not a chunk.
    let len = bytes.len().min(riff.saturating_add(8));
    let mut at = 12;
    while at + 8 <= len {
        let Some(size) = word(at + 4) else {
            return false;
        };
        let end = (at + 8).saturating_add(size).saturating_add(size & 1);
        if end > len && (at + 8).saturating_add(size) > len {
            return false;
        }
        at = end;
    }
    true
}

/// Opens a decoder with the limits on, and refuses the picture if what it
/// will allocate is past them — all from the header, before any pixels.
fn open(bytes: &[u8]) -> Result<impl ImageDecoder + '_, ImageError> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|err| ImageError::Decode(err.to_string()))?;
    let format = reader.format();
    if format == Some(ImageFormat::WebP) && !webp_chunks_fit(bytes) {
        return Err(ImageError::Decode(
            "a WebP chunk claims more bytes than the file holds".to_string(),
        ));
    }

    let mut limits = Limits::default();
    limits.max_image_width = Some(LONGEST_SIDE);
    limits.max_image_height = Some(LONGEST_SIDE);
    limits.max_alloc = Some(MOST_BYTES);
    reader.limits(limits.clone());

    let mut decoder = reader.into_decoder().map_err(decoding)?;
    let (width, height) = decoder.dimensions();
    fits(&format!("{width}×{height}"), decoder.total_bytes())?;

    // The budget is for the whole decode, not for each buffer in it. A GIF
    // reserves its frame, and a TIFF its strip buffer, from the limit it was
    // given — on top of the picture they are filling. So those two are given
    // what is left once the picture is counted: a 1×1 screen with a huge
    // frame, or a screen and a frame that are each the whole budget, are
    // refused rather than held twice. PNG counts the picture itself and keeps
    // the full limit; JPEG and WebP take none from `image` to reduce.
    if matches!(format, Some(ImageFormat::Gif | ImageFormat::Tiff)) {
        let mut rest = limits;
        rest.max_alloc = Some(MOST_BYTES.saturating_sub(decoder.total_bytes()));
        decoder.set_limits(rest).map_err(decoding)?;
    }
    Ok(decoder)
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
    let mut decoder = open(bytes)?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);

    let mut image = DynamicImage::from_decoder(decoder).map_err(decoding)?;

    let reoriented = orientation != Orientation::NoTransforms;
    if reoriented {
        image.apply_orientation(orientation);
    }
    Ok((image, reoriented))
}

/// What the file is, without transforming anything — and without decoding it.
///
/// The header holds all of it: the size, the orientation and the format. It
/// used to decode every pixel for those three facts, which in a browser was a
/// quarter of a second for a 12-megapixel photograph and a second for a
/// 50-megapixel one, just to open it. A file whose pixels are damaged behind a
/// sound header now opens as editable and fails when it is written, saying
/// that it could not be read.
pub fn info(bytes: &[u8]) -> Result<Info, ImageError> {
    let format = guess(bytes);
    let mut decoder = open(bytes)?;
    let (width, height) = decoder.dimensions();
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let (width, height) = match orientation {
        Orientation::Rotate90
        | Orientation::Rotate270
        | Orientation::Rotate90FlipH
        | Orientation::Rotate270FlipH => (height, width),
        _ => (width, height),
    };
    let encoding = format.and_then(Encoding::from_format);
    Ok(Info {
        width,
        height,
        encoding,
        reoriented: orientation != Orientation::NoTransforms,
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
        // In u64, so that a rectangle placed near u32::MAX cannot wrap round
        // to a small number and pass.
        if u64::from(rect.x) + u64::from(rect.width) > u64::from(image.width())
            || u64::from(rect.y) + u64::from(rect.height) > u64::from(image.height())
        {
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
        let target = format!("{}×{}", size.width, size.height);
        fits(
            &target,
            u64::from(size.width)
                * u64::from(size.height)
                * u64::from(image.color().bytes_per_pixel()),
        )?;
        // The first pass of the resize holds the source's width at the
        // target's height, in f32. A large photograph made much smaller would
        // spend most of that on columns about to be thrown away, so it is
        // first brought down to twice the target by whole-pixel averaging,
        // which allocates only its result, and Lanczos does the rest.
        let pass =
            |width: u32| u64::from(width) * u64::from(size.height) * RESAMPLE_BYTES_PER_PIXEL;
        if pass(image.width()) > MOST_BYTES && image.width() / 2 > size.width {
            let width = size.width.saturating_mul(2);
            let height = image.height().min(size.height.saturating_mul(2));
            image = image.thumbnail_exact(width, height);
        }
        fits(&format!("resizing to {target}"), pass(image.width()))?;
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

/// The same two functions, for the browser build.
///
/// On desktop the bytes never enter the webview; in a browser there is nowhere
/// else for them to be, so the page reads the file, hands the bytes over and
/// writes back what comes out. The limits above are what make that safe to do
/// with a file somebody else made: an instance that runs out of memory aborts.
#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    fn fail(err: super::ImageError) -> JsValue {
        JsValue::from_str(&err.to_string())
    }

    #[wasm_bindgen(js_name = imageInfo)]
    pub fn image_info(bytes: &[u8]) -> Result<JsValue, JsValue> {
        let info = super::info(bytes).map_err(fail)?;
        serde_wasm_bindgen::to_value(&info).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// The encoded bytes and what they hold — the picture handed over once,
    /// and no second copy of it inside a serialised object.
    #[wasm_bindgen]
    pub struct Applied {
        bytes: Vec<u8>,
        written: super::Written,
    }

    #[wasm_bindgen]
    impl Applied {
        /// Hands the picture over rather than copying it: the one copy left
        /// is the one out of WebAssembly memory into the page.
        #[wasm_bindgen(js_name = takeBytes)]
        pub fn take_bytes(&mut self) -> Vec<u8> {
            std::mem::take(&mut self.bytes)
        }

        #[wasm_bindgen(getter)]
        pub fn written(&self) -> Result<JsValue, JsValue> {
            serde_wasm_bindgen::to_value(&self.written)
                .map_err(|e| JsValue::from_str(&e.to_string()))
        }
    }

    #[wasm_bindgen(js_name = imageApply)]
    pub fn image_apply(bytes: &[u8], ops: JsValue) -> Result<Applied, JsValue> {
        let ops: super::Ops =
            serde_wasm_bindgen::from_value(ops).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let (bytes, written) = super::apply(bytes, &ops).map_err(fail)?;
        Ok(Applied { bytes, written })
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

    /// PNG's CRC-32, bit by bit — four lines rather than a dependency.
    fn crc32(data: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &byte in data {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn pixel_at(bytes: &[u8], x: u32, y: u32) -> [u8; 4] {
        let image = image::load_from_memory(bytes).unwrap().to_rgba8();
        image.get_pixel(x, y).0
    }

    #[test]
    fn a_header_past_the_limit_is_refused_before_decoding() {
        // A real PNG header claiming 20 000 × 20 000, with no pixels behind it:
        // the refusal has to come from the header, not from an allocation.
        let mut bytes = corner_png();
        bytes[16..20].copy_from_slice(&20_000u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&20_000u32.to_be_bytes());
        // The chunk's checksum covers its type and data, and the decoder
        // checks it — without a fresh one this is a corrupt file, not a big one.
        let crc = crc32(&bytes[12..29]);
        bytes[29..33].copy_from_slice(&crc.to_be_bytes());
        assert!(matches!(info(&bytes), Err(ImageError::TooLarge(_))));
        assert!(matches!(
            apply(&bytes, &Ops::default()),
            Err(ImageError::TooLarge(_))
        ));
    }

    #[test]
    fn the_limit_is_counted_in_bytes_not_pixels() {
        // 9 000 × 9 000 is 81 megapixels, under a hundred — but as 16-bit RGBA
        // it is 648 MB. The file chooses the depth, so the depth counts.
        let mut bytes = corner_png();
        bytes[16..20].copy_from_slice(&9_000u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&9_000u32.to_be_bytes());
        bytes[24] = 16;
        let crc = crc32(&bytes[12..29]);
        bytes[29..33].copy_from_slice(&crc.to_be_bytes());
        assert!(matches!(info(&bytes), Err(ImageError::TooLarge(_))));
    }

    #[test]
    fn a_gif_frame_larger_than_its_screen_is_held_to_the_same_limit() {
        // A 1×1 screen passes any look at the header; the frame inside it
        // claims 12 000 × 12 000, which is 576 MB of RGBA. Thirty-odd bytes.
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&[1, 0, 1, 0, 0x80, 0, 0]); // screen 1×1, two colours
        gif.extend_from_slice(&[0, 0, 0, 255, 255, 255]);
        gif.push(0x2C); // image descriptor
        gif.extend_from_slice(&[0, 0, 0, 0]); // at 0,0
        gif.extend_from_slice(&12_000u16.to_le_bytes());
        gif.extend_from_slice(&12_000u16.to_le_bytes());
        gif.extend_from_slice(&[0, 2, 0, 0x3B]); // no palette, LZW 2, no data, end
        assert!(info(&gif).is_ok(), "the header is a 1×1 picture");
        // Saved as a PNG, which is what the editor does with a GIF.
        let as_png = Ops {
            encoding: Some(Encoding::Png),
            ..Ops::default()
        };
        let result = apply(&gif, &as_png);
        assert!(
            matches!(result, Err(ImageError::TooLarge(_))),
            "{:?}",
            result.map(|r| r.1)
        );
    }

    #[test]
    fn a_wide_picture_made_much_smaller_does_not_hold_its_width_in_floats() {
        // Straight into Lanczos, the first pass would hold 40 000 columns at a
        // thousand rows in f32: 640 MB, for a result of 10 × 1 000. Brought
        // down to twice the target first, it is a few hundred kilobytes.
        let wide = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            40_000,
            2,
            image::Rgba([0, 0, 255, 255]),
        ));
        let mut out = Cursor::new(Vec::new());
        wide.write_to(&mut out, ImageFormat::Png).unwrap();
        let ops = Ops {
            resize: Some(Size {
                width: 10,
                height: 1_000,
            }),
            ..Ops::default()
        };
        let (_, written) = apply(&out.into_inner(), &ops).unwrap();
        assert_eq!((written.width, written.height), (10, 1_000));
    }

    #[test]
    fn a_sideways_photograph_reads_the_way_up_it_will_be_written() {
        // A 4×2 JPEG whose Exif says "turn a quarter clockwise": the size
        // `info` reads from the header has to be the size `apply` writes.
        let mut jpeg = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image::RgbImage::from_pixel(4, 2, image::Rgb([9, 9, 9])))
            .write_to(&mut jpeg, ImageFormat::Jpeg)
            .unwrap();
        let jpeg = jpeg.into_inner();
        let mut exif = b"Exif\0\0II*\0\x08\0\0\0\x01\0".to_vec();
        exif.extend_from_slice(&[0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
        let mut tagged = jpeg[..2].to_vec();
        tagged.extend_from_slice(&[0xFF, 0xE1]);
        tagged.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        tagged.extend_from_slice(&exif);
        tagged.extend_from_slice(&jpeg[2..]);

        let read = info(&tagged).unwrap();
        assert!(read.reoriented);
        assert_eq!((read.width, read.height), (2, 4));
        let (_, written) = apply(&tagged, &Ops::default()).unwrap();
        assert_eq!((written.width, written.height), (read.width, read.height));
    }

    #[test]
    fn a_webp_chunk_claiming_more_than_the_file_is_not_read() {
        // RIFF/WEBP, a VP8X header for a 100×100 canvas with Exif flagged,
        // then an Exif chunk that declares four gigabytes and holds eight bytes.
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&0u32.to_le_bytes()); // patched below
        webp.extend_from_slice(b"WEBPVP8X");
        webp.extend_from_slice(&10u32.to_le_bytes());
        webp.extend_from_slice(&[0x08, 0, 0, 0]); // flags: Exif
        webp.extend_from_slice(&[99, 0, 0, 99, 0, 0]); // 100×100, less one
        webp.extend_from_slice(b"EXIF");
        webp.extend_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
        webp.extend_from_slice(&[0; 8]);
        let riff = (webp.len() - 8) as u32;
        webp[4..8].copy_from_slice(&riff.to_le_bytes());
        // Refused by the look at the chunks, not by a decoder that allocated
        // first and failed after: on 64-bit the allocation can even succeed.
        let refused = info(&webp);
        assert!(
            matches!(&refused, Err(ImageError::Decode(why)) if why.contains("claims more bytes")),
            "{refused:?}"
        );
    }

    #[test]
    fn a_gif_screen_and_frame_are_one_budget_not_two() {
        // A screen that is the whole budget on its own, 10 000 × 10 000 RGBA,
        // and a frame just as large beside it: each fits, the two do not.
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&10_000u16.to_le_bytes());
        gif.extend_from_slice(&10_000u16.to_le_bytes());
        gif.extend_from_slice(&[0x80, 0, 0, 0, 0, 0, 255, 255, 255]);
        gif.push(0x2C);
        gif.extend_from_slice(&[1, 0, 0, 0]); // at 1,0: not the screen itself
        gif.extend_from_slice(&10_000u16.to_le_bytes());
        gif.extend_from_slice(&10_000u16.to_le_bytes());
        gif.extend_from_slice(&[0, 2, 0, 0x3B]);
        let as_png = Ops {
            encoding: Some(Encoding::Png),
            ..Ops::default()
        };
        let result = apply(&gif, &as_png);
        assert!(
            matches!(result, Err(ImageError::TooLarge(_))),
            "{:?}",
            result.map(|r| r.1)
        );
    }

    #[test]
    fn a_resize_past_the_limit_is_refused() {
        let ops = Ops {
            resize: Some(Size {
                width: 20_000,
                height: 20_000,
            }),
            ..Ops::default()
        };
        assert!(matches!(
            apply(&corner_png(), &ops),
            Err(ImageError::TooLarge(_))
        ));
    }

    #[test]
    fn a_crop_near_the_end_of_u32_does_not_wrap_into_the_picture() {
        let ops = Ops {
            crop: Some(Rect {
                x: u32::MAX,
                y: 0,
                width: 2,
                height: 1,
            }),
            ..Ops::default()
        };
        assert!(matches!(
            apply(&corner_png(), &ops),
            Err(ImageError::Crop(_))
        ));
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
