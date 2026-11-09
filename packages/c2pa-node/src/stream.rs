// Copyright 2026 Adobe. All rights reserved.
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

//! A `Read + Seek` stream over a JavaScript source that reads by position, so an asset can be
//! read without having it on local disk or wholly in memory.
//!
//! The source's `read` has the shape of `fs.read(fd, buffer, offset, length, position,
//! callback)`, so a file descriptor, an HTTP range client or an object store client can serve
//! it. Each call crosses to the JavaScript thread and back, so reads are served from a block
//! the size of the shared buffer: the many small header reads during parsing cost one call per
//! block, and hashing reads a block per call.

use std::cell::RefCell;
use std::io::{self, Read, Seek, SeekFrom};
use std::rc::Rc;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;

use neon::prelude::*;
use neon::types::buffer::TypedArray;

use crate::asset::NeonReadStreamTrait;

/// The block size when the source doesn't set `bufferSize`.
const DEFAULT_BUFFER_SIZE: usize = 1024 * 1024;

/// The JavaScript values every read uses: the source, kept as `this`, and the buffer handed to
/// `read`, allocated once.
struct Roots {
    source: Root<JsObject>,
    buffer: Root<JsBuffer>,
}

/// What a read sends back: the block, filled with the bytes read, and their number or the
/// source's error.
type Answer = (Vec<u8>, io::Result<usize>);

/// A `Read + Seek` stream over a JavaScript source. Bytes are served from the last block read,
/// which starts at a multiple of the block size so a read that steps back a little still hits.
pub struct JsStream {
    channel: Channel,
    roots: Arc<Roots>,
    size: u64,
    buffer_size: usize,
    position: u64,
    block: Vec<u8>,
    block_start: u64,
}

impl JsStream {
    /// Parses `{ size, read, bufferSize? }` on the JavaScript thread.
    pub fn parse(cx: &mut FunctionContext, source: Handle<JsObject>) -> NeonResult<Self> {
        let size = source.get::<JsNumber, _, _>(cx, "size")?.value(cx);
        if !size.is_finite() || size < 0.0 || size.fract() != 0.0 {
            return cx.throw_range_error("stream.size must be a non-negative integer");
        }
        // Validated here so a bad source fails before reading starts, not on the first read.
        source.get::<JsFunction, _, _>(cx, "read")?;

        let buffer_size = match source.get_opt::<JsNumber, _, _>(cx, "bufferSize")? {
            Some(value) => {
                let value = value.value(cx);
                if !value.is_finite() || value < 1.0 || value.fract() != 0.0 {
                    return cx.throw_range_error("stream.bufferSize must be a positive integer");
                }
                value as usize
            }
            None => DEFAULT_BUFFER_SIZE,
        };

        let buffer = JsBuffer::new(cx, buffer_size)?;
        Ok(Self {
            channel: cx.channel(),
            roots: Arc::new(Roots {
                source: source.root(cx),
                buffer: buffer.root(cx),
            }),
            size: size as u64,
            buffer_size,
            position: 0,
            block: Vec::with_capacity(buffer_size),
            block_start: 0,
        })
    }

    /// Reads the block holding `position`, waiting for the JavaScript side to answer.
    fn fill_block(&mut self) -> io::Result<()> {
        let buffer_size = self.buffer_size as u64;
        let start = self.position - self.position % buffer_size;
        let length = buffer_size.min(self.size - start) as usize;
        let block = std::mem::take(&mut self.block);
        let roots = Arc::clone(&self.roots);
        let (answer, answered) = sync_channel(1);

        self.channel
            .try_send(move |mut cx| {
                read_block(&mut cx, roots, start, length, block, answer);
                Ok(())
            })
            .map_err(io::Error::other)?;

        // Waiting blocks this thread, so tell the runtime to move its other tasks elsewhere.
        let (block, bytes_read) = tokio::task::block_in_place(|| answered.recv())
            .map_err(|_| io::Error::other("stream.read was dropped without calling back"))?;
        self.block = block;
        self.block_start = start;
        if let Err(err) = bytes_read {
            self.block.clear();
            return Err(err);
        }
        Ok(())
    }

    fn in_block(&self) -> bool {
        self.position >= self.block_start
            && self.position < self.block_start + self.block.len() as u64
    }
}

/// Calls the source's `read` for one block, on the JavaScript thread. Its callback copies the
/// bytes into `block`, since the buffer can only be read here, and sends both back. Only the
/// first answer is taken, so a source that calls back twice, or throws after calling back,
/// can't answer a later read.
fn read_block(
    cx: &mut TaskContext,
    roots: Arc<Roots>,
    start: u64,
    length: usize,
    block: Vec<u8>,
    answer: SyncSender<Answer>,
) {
    let pending = Rc::new(RefCell::new(Some((block, answer))));
    let reply = {
        let pending = Rc::clone(&pending);
        move |result: Result<&[u8], String>| {
            if let Some((mut block, answer)) = pending.borrow_mut().take() {
                block.clear();
                let bytes_read = result.map(|bytes| {
                    block.extend_from_slice(bytes);
                    bytes.len()
                });
                let _ = answer.send((block, bytes_read.map_err(io::Error::other)));
            }
        }
    };

    let called = cx.try_catch(|cx| {
        let source = roots.source.to_inner(cx);
        let buffer = roots.buffer.to_inner(cx);
        let reply = reply.clone();
        let callback = JsFunction::new(cx, move |mut cx| {
            let buffer = roots.buffer.to_inner(&mut cx);
            match cx.argument_opt(0) {
                Some(err)
                    if !err.is_a::<JsNull, _>(&mut cx) && !err.is_a::<JsUndefined, _>(&mut cx) =>
                {
                    reply(Err(error_message(&mut cx, err)));
                }
                _ => {
                    let bytes_read = cx
                        .argument_opt(1)
                        .and_then(|value| value.downcast::<JsNumber, _>(&mut cx).ok())
                        .map_or(f64::NAN, |value| value.value(&mut cx));
                    if bytes_read >= 0.0 && bytes_read <= length as f64 && bytes_read.fract() == 0.0
                    {
                        reply(Ok(&buffer.as_slice(&cx)[..bytes_read as usize]));
                    } else {
                        reply(Err(format!(
                            "stream.read reported {bytes_read} bytes read of {length} asked for"
                        )));
                    }
                }
            }
            Ok(cx.undefined())
        })?;

        let read = source.get::<JsFunction, _, _>(cx, "read")?;
        let args = [
            buffer.upcast::<JsValue>(),
            cx.number(0).upcast(),
            cx.number(length as f64).upcast(),
            cx.number(start as f64).upcast(),
            callback.upcast(),
        ];
        read.call(cx, source, args)
    });

    // A source that throws instead of calling back fails the read.
    if let Err(err) = called {
        reply(Err(error_message(cx, err)));
    }
}

/// The message of an error from the source. It never throws, since the reading thread waits
/// for an answer whatever the error is.
fn error_message<'a, C: Context<'a>>(cx: &mut C, err: Handle<'a, JsValue>) -> String {
    cx.try_catch(|cx| Ok(err.to_string(cx)?.value(cx)))
        .unwrap_or_else(|_| "stream.read failed".to_string())
}

impl Read for JsStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.position >= self.size {
            return Ok(0);
        }
        if !self.in_block() {
            self.fill_block()?;
            // A short read from the source ends the stream rather than looping on it.
            if !self.in_block() {
                return Ok(0);
            }
        }

        let from = (self.position - self.block_start) as usize;
        let count = buf.len().min(self.block.len() - from);
        buf[..count].copy_from_slice(&self.block[from..from + count]);
        self.position += count as u64;
        Ok(count)
    }
}

impl Seek for JsStream {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let position = match pos {
            SeekFrom::Start(offset) => Some(offset),
            SeekFrom::End(offset) => self.size.checked_add_signed(offset),
            SeekFrom::Current(offset) => self.position.checked_add_signed(offset),
        };
        let Some(position) = position else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid seek to a negative or overflowing position",
            ));
        };
        self.position = position;
        Ok(position)
    }

    fn stream_position(&mut self) -> io::Result<u64> {
        Ok(self.position)
    }
}

impl NeonReadStreamTrait for JsStream {}
