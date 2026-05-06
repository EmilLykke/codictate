use super::protocol::IndicatorStatus;
use std::time::Instant;
use windows_sys::Win32::Foundation::RECT;
use windows_sys::Win32::Graphics::Gdi::{
    CreatePen, CreateSolidBrush, DeleteObject, Ellipse, HDC, PS_SOLID, RoundRect, SelectObject,
};

pub const INDICATOR_TIMER_ID: usize = 1;
pub const INDICATOR_FRAME_MS: u32 = 33;

const INDICATOR_MAX_ORB_SIZE: f32 = 56.0;
const INDICATOR_READY_SCALE: f32 = 38.0 / INDICATOR_MAX_ORB_SIZE;

pub struct IndicatorAnimation {
    animation_time: f32,
    current_scale: f32,
    last_tick: Instant,
}

impl Default for IndicatorAnimation {
    fn default() -> Self {
        Self {
            animation_time: 0.0,
            current_scale: INDICATOR_READY_SCALE,
            last_tick: Instant::now(),
        }
    }
}

impl IndicatorAnimation {
    pub fn update(&mut self, status: IndicatorStatus) {
        let now = Instant::now();
        let delta = now.duration_since(self.last_tick).as_secs_f32();
        self.last_tick = now;
        self.animation_time += delta;
        let target_scale = match status {
            IndicatorStatus::Ready => INDICATOR_READY_SCALE,
            IndicatorStatus::Recording | IndicatorStatus::Transcribing => 1.0,
        };
        let speed = (delta * 14.0).min(1.0);
        self.current_scale += (target_scale - self.current_scale) * speed;
    }

    pub fn reset_tick(&mut self) {
        self.last_tick = Instant::now();
    }

    pub fn frame(&self) -> (f32, f32) {
        (self.animation_time, self.current_scale)
    }
}

pub fn rgb(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

fn indicator_color(status: IndicatorStatus) -> u32 {
    match status {
        IndicatorStatus::Ready => rgb(30, 32, 38),
        IndicatorStatus::Recording => rgb(44, 26, 30),
        IndicatorStatus::Transcribing => rgb(43, 31, 20),
    }
}

fn draw_filled_ellipse(hdc: HDC, rect: RECT, fill: u32, outline: u32, pen_width: i32) {
    let brush = unsafe { CreateSolidBrush(fill) };
    let pen = unsafe { CreatePen(PS_SOLID, pen_width, outline) };
    unsafe {
        let old_brush = SelectObject(hdc, brush as _);
        let old_pen = SelectObject(hdc, pen as _);
        Ellipse(hdc, rect.left, rect.top, rect.right, rect.bottom);
        SelectObject(hdc, old_pen);
        SelectObject(hdc, old_brush);
        DeleteObject(pen as _);
        DeleteObject(brush as _);
    }
}

fn draw_bar(hdc: HDC, rect: RECT, color: u32, radius: i32) {
    let brush = unsafe { CreateSolidBrush(color) };
    let pen = unsafe { CreatePen(PS_SOLID, 1, color) };
    unsafe {
        let old_brush = SelectObject(hdc, brush as _);
        let old_pen = SelectObject(hdc, pen as _);
        RoundRect(
            hdc,
            rect.left,
            rect.top,
            rect.right,
            rect.bottom,
            radius,
            radius,
        );
        SelectObject(hdc, old_pen);
        SelectObject(hdc, old_brush);
        DeleteObject(pen as _);
        DeleteObject(brush as _);
    }
}

fn interpolate(progress: f32, values: &[f32]) -> f32 {
    if values.len() < 2 {
        return values.first().copied().unwrap_or(1.0);
    }

    let segment_count = values.len() - 1;
    let scaled = progress.clamp(0.0, 0.999_999) * segment_count as f32;
    let index = scaled.floor() as usize;
    let local = scaled - index as f32;
    values[index] + (values[index + 1] - values[index]) * local
}

fn draw_ready_bars(hdc: HDC, orb_rect: RECT, active: bool, animation_time: f32) {
    let width = (orb_rect.right - orb_rect.left).max(1) as f32;
    let scale = width / INDICATOR_MAX_ORB_SIZE;
    let row_height = (16.0 * scale).round() as i32;
    let bar_width = (3.0 * scale).round().max(1.0) as i32;
    let gap = (2.0 * scale).round().max(1.0) as i32;
    let total_width = bar_width * 5 + gap * 4;
    let origin_x = (orb_rect.left + orb_rect.right - total_width) / 2;
    let origin_y = (orb_rect.top + orb_rect.bottom - row_height) / 2;
    let bases = [0.45_f32, 0.75, 1.0, 0.7, 0.5];

    for (index, base) in bases.iter().enumerate() {
        let scale_y = if active {
            let duration = 0.58 + index as f32 * 0.06;
            let progress = ((animation_time + index as f32 * 0.09) / duration).rem_euclid(1.0);
            interpolate(progress, &[*base, base * 0.35 + 0.12, base + 0.18, *base])
        } else {
            *base
        };
        let height = ((row_height as f32) * scale_y).round().max(2.0) as i32;
        let x = origin_x + index as i32 * (bar_width + gap);
        let y = origin_y + row_height - height;
        let color = if active {
            match index {
                0 | 4 => rgb(198, 68, 76),
                1 | 3 => rgb(224, 78, 88),
                _ => rgb(248, 86, 96),
            }
        } else {
            match index {
                0 | 4 => rgb(126, 132, 142),
                1 | 3 => rgb(146, 152, 162),
                _ => rgb(178, 184, 194),
            }
        };
        draw_bar(
            hdc,
            RECT {
                left: x,
                top: y,
                right: x + bar_width,
                bottom: origin_y + row_height,
            },
            color,
            bar_width,
        );
    }
}

fn draw_transcribing_bars(hdc: HDC, orb_rect: RECT, animation_time: f32) {
    let width = (orb_rect.right - orb_rect.left).max(1) as f32;
    let scale = width / INDICATOR_MAX_ORB_SIZE;
    let row_height = (16.0 * scale).round() as i32;
    let bar_width = (3.0 * scale).round().max(1.0) as i32;
    let gap = (2.0 * scale).round().max(1.0) as i32;
    let total_width = bar_width * 3 + gap * 2;
    let origin_x = (orb_rect.left + orb_rect.right - total_width) / 2;
    let origin_y = (orb_rect.top + orb_rect.bottom - row_height) / 2;

    for index in 0..3 {
        let progress = ((animation_time + index as f32 * 0.14) / 0.85).rem_euclid(1.0);
        let scale_y = interpolate(progress, &[0.28, 1.0, 0.28]);
        let height = ((row_height as f32) * scale_y).round().max(2.0) as i32;
        let x = origin_x + index * (bar_width + gap);
        let y = origin_y + row_height - height;
        draw_bar(
            hdc,
            RECT {
                left: x,
                top: y,
                right: x + bar_width,
                bottom: origin_y + row_height,
            },
            rgb(218, 139, 62),
            bar_width,
        );
    }
}

pub fn draw_indicator_content(
    hdc: HDC,
    status: IndicatorStatus,
    bounds: RECT,
    animation_time: f32,
    current_scale: f32,
) {
    let display_size = (INDICATOR_MAX_ORB_SIZE * current_scale).round() as i32;
    let orb_rect = RECT {
        left: (bounds.left + bounds.right - display_size) / 2,
        top: (bounds.top + bounds.bottom - display_size) / 2,
        right: (bounds.left + bounds.right + display_size) / 2,
        bottom: (bounds.top + bounds.bottom + display_size) / 2,
    };

    let outline = match status {
        IndicatorStatus::Ready => rgb(38, 41, 48),
        IndicatorStatus::Recording => rgb(58, 39, 43),
        IndicatorStatus::Transcribing => rgb(66, 45, 26),
    };

    draw_filled_ellipse(hdc, orb_rect, rgb(2, 3, 5), rgb(15, 17, 22), 1);
    draw_filled_ellipse(hdc, orb_rect, indicator_color(status), outline, 1);

    match status {
        IndicatorStatus::Ready => draw_ready_bars(hdc, orb_rect, false, animation_time),
        IndicatorStatus::Recording => draw_ready_bars(hdc, orb_rect, true, animation_time),
        IndicatorStatus::Transcribing => draw_transcribing_bars(hdc, orb_rect, animation_time),
    }
}
