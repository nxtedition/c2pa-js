// Copyright 2025 Adobe. All rights reserved.
// This file is licensed to you under the Apache License,
// Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0)
// or the MIT license (http://opensource.org/licenses/MIT),
// at your option.

// Unless required by applicable law or agreed to in writing,
// this software is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR REPRESENTATIONS OF ANY KIND, either express or
// implied. See the LICENSE-MIT and LICENSE-APACHE files for the
// specific language governing permissions and limitations under
// each license.

use std::fs::{File, OpenOptions};
use std::io::{BufReader, Cursor, Read, Seek, Write};
use std::path::Path;

use c2pa::format_from_path;
use neon::prelude::*;
use neon::types::buffer::TypedArray;

use crate::error::Error;
use crate::stream::JsStream;

pub(crate) trait NeonReadStreamTrait: Read + Seek + Send {}
pub(crate) trait NeonWriteStreamTrait: Write + Read + Seek + Send {}

impl NeonReadStreamTrait for Cursor<Vec<u8>> {}
impl NeonReadStreamTrait for BufReader<File> {}

impl NeonWriteStreamTrait for Cursor<Vec<u8>> {}
impl NeonWriteStreamTrait for File {}

pub enum Asset {
    SourceBuffer(Vec<u8>, Option<String>),
    File(String, Option<String>),
    DestinationBuffer(Vec<u8>),
    /// Read by position through a JavaScript source. Only a reader accepts one.
    Stream(JsStream, Option<String>),
}

impl Asset {
    /// The asset's MIME type, if known.
    ///
    /// For a `File`, an omitted MIME type falls back to a guess from the path's extension.
    /// Returns `None` when the MIME type isn't supplied and can't be inferred; callers reading
    /// an asset (as opposed to signing one) can fall back to an empty format string and let the
    /// native library detect the format from the asset's bytes.
    ///
    /// Callers should supply the real MIME type whenever it's known and only omit it when there
    /// is no way to determine it.
    pub fn mime_type(&self) -> Option<String> {
        match self {
            Asset::SourceBuffer(_, mime_type) => mime_type.clone(),
            Asset::Stream(_, mime_type) => mime_type.clone(),
            Asset::File(path, mime_type) => mime_type
                .clone()
                .or_else(|| format_from_path(Path::new(&path))),
            _ => None,
        }
    }
    pub fn into_read_stream(self) -> Result<Box<dyn NeonReadStreamTrait>, Error> {
        match self {
            Asset::SourceBuffer(buffer, _) => Ok(Box::new(Cursor::new(buffer))),
            Asset::File(path, _) => {
                let file = File::open(Path::new(&path)).map_err(Error::from)?;
                Ok(Box::new(BufReader::new(file)))
            }
            Asset::Stream(stream, _) => Ok(Box::new(stream)),
            _ => Err(Error::Asset("Cannot write to source buffer".to_string())),
        }
    }

    pub fn write_stream(&self) -> Result<Box<dyn NeonWriteStreamTrait>, Error> {
        match self {
            Asset::File(path, _) => {
                let file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .open(Path::new(&path))
                    .map_err(Error::from)?;
                Ok(Box::new(file))
            }
            Asset::DestinationBuffer(buffer) => Ok(Box::new(Cursor::new(buffer.to_owned()))),
            _ => Err(Error::Asset("Cannot write to source buffer".to_string())),
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Asset::File(_, _) => "file",
            Asset::DestinationBuffer(_) => "destination_buffer",
            Asset::SourceBuffer(_, _) => "source_buffer",
            Asset::Stream(_, _) => "stream",
        }
    }
}

/// Parses an asset a reader reads, which may also be a `stream` source read by position.
pub fn parse_read_asset(cx: &mut FunctionContext, obj: Handle<JsObject>) -> NeonResult<Asset> {
    match obj.get_opt::<JsObject, _, _>(cx, "stream")? {
        Some(stream) => {
            let mime_type = obj
                .get_opt::<JsString, _, _>(cx, "mimeType")?
                .map(|val| val.value(cx));
            Ok(Asset::Stream(JsStream::parse(cx, stream)?, mime_type))
        }
        None => parse_asset(cx, obj),
    }
}

pub fn parse_asset(cx: &mut FunctionContext, obj: Handle<JsObject>) -> NeonResult<Asset> {
    // A stream source waits on the JavaScript thread, which the APIs taking this asset may be
    // running on, so it would never be answered. Without this it would pass as a destination.
    if obj.get_opt::<JsValue, _, _>(cx, "stream")?.is_some() {
        return cx.throw_type_error(
            "A stream asset can only be read with Reader; pass a buffer or a path",
        );
    }
    let mime_type = obj
        .get_opt::<JsString, _, _>(cx, "mimeType")?
        .map(|val| val.value(cx))
        .or(None);
    let path = obj
        .get_opt::<JsString, _, _>(cx, "path")?
        .map(|val| val.value(cx))
        .or(None);
    let buffer_value = obj.get::<JsValue, _, _>(cx, "buffer")?;
    let buffer = if buffer_value.is_a::<JsBuffer, _>(cx) {
        Some(
            buffer_value
                .downcast_or_throw::<JsBuffer, _>(cx)?
                .as_slice(cx)
                .to_vec(),
        )
    } else {
        None
    };

    match (buffer, path) {
        (Some(buffer), _) => Ok(Asset::SourceBuffer(buffer, mime_type)),
        (None, Some(path)) => Ok(Asset::File(path, mime_type)),
        (None, None) => Ok(Asset::DestinationBuffer(Vec::new())),
    }
}
