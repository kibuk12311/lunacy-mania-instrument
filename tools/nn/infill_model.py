"""nn-v2: the infill transformer of the ML addendum (§4.4), in PyTorch, for training and as the reference that the
plain-JS inference (src/gen/nn/infillModel.js) must match within 2e-3.

Tokens are beats. A beat's input is 8 slot lanes x 12 values + the beat features (45) + its divisor one-hot (4) =
145 values. The visible chart (the locked rows at inference) is added as mask/lane embeddings, the conditions
(dan, MSD, family, style, data source, rate) are added to every beat. A bidirectional encoder with local ALiBi
attention (+-32 beats, up to 2 echo keys, 4 global condition tokens) runs once per prepare; a causal decoder over
beats (self-attention over the last 32 beats, cross-attention to the encoder at +-32 beats) and a per-slot lane
head give 16 logits per slot (logit 0 = no row, k = the row with column mask k).

Everything below is written so that a step-by-step decode (what the JS does) gives exactly what this parallel
teacher-forced forward gives; tools/nn/test_infill.py checks the causality.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, asdict, field
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F

N_LANES = 8
LANE_VALUES = ["onset", "low", "mid", "high", "kick", "snare", "hat", "harm", "perc_share", "energy", "phase", "present"]
N_LANE_VALUES = len(LANE_VALUES)
BEAT_FEATURES = [f"s{k}" for k in range(12)] + ["beat_max", "energy", "bpm"]
BEAT_FEATURES_V3 = (BEAT_FEATURES + [f"chroma{k}" for k in range(12)] + [f"timbre{k}" for k in range(12)]
                    + ["phrase_pos", "is_phrase_start", "has_echo", "rep_sim", "novelty", "meter"])
DIV_CLASSES = [4, 3, 6, 8]
IN_DIM = N_LANES * N_LANE_VALUES + len(BEAT_FEATURES_V3) + len(DIV_CLASSES)  # 145
FAMILIES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jack", "Tech"]
FAM_UNKNOWN = len(FAMILIES)  # 6
N_FAM = FAM_UNKNOWN + 1
SOURCES = ["unknown", "osu", "etterna", "malody"]
N_HIST = 4
HIST_DIM = 17  # one-hot mask (16) + gap
N_CLASSES = 16
DAN_FOURIER = 16
COND_DIM = DAN_FOURIER + 1 + 8 + 1 + 1  # fourier(dan), dan known, msd/20, msd known, rate - 1
MSD_SCALE = 20.0
GAP_CLIP_BEATS = 4.0
LANE_EMB = 16

SIZES_FILE = Path(__file__).with_name("sizes.json")


def load_sizes():
    return {k: v for k, v in json.loads(SIZES_FILE.read_text(encoding="utf-8")).items() if not k.startswith("_")}


@dataclass
class Cfg:
    d: int = 96
    enc_layers: int = 4
    enc_heads: int = 4
    enc_ffn: int = 384
    dec_d: int = 64
    dec_layers: int = 2
    dec_heads: int = 4
    dec_ffn: int = 256
    lane_hidden: int = 64
    lane_emb: int = LANE_EMB
    win: int = 32
    dec_win: int = 32
    cross_win: int = 32
    n_glob: int = 4
    n_styles: int = 1  # K + 1 (index 0 = no style)
    n_sources: int = len(SOURCES)
    size: str = "S"

    @staticmethod
    def preset(name: str, **over):
        sizes = load_sizes()
        if name not in sizes:
            raise ValueError(f"unknown size {name}; known: {', '.join(sizes)}")
        return Cfg(**{**sizes[name], "size": name, **over})

    def to_json(self):
        return asdict(self)


def alibi_slopes(h: int) -> torch.Tensor:
    return torch.tensor([2.0 ** (-8.0 * (i + 1) / h) for i in range(h)], dtype=torch.float32)


def dan_fourier(dan: torch.Tensor) -> torch.Tensor:
    """(...,) dan -> (..., 16): sin then cos at periods 40 / 2^(k/2), k = 0..7."""
    periods = torch.tensor([40.0 / 2 ** (k / 2) for k in range(8)], dtype=torch.float32, device=dan.device)
    a = 2 * math.pi * dan.float()[..., None] / periods
    return torch.cat([torch.sin(a), torch.cos(a)], -1)


def cond_vector(dan, dan_known, msd, msd_known, rate):
    """The 27 condition values: fourier(dan) (zeros when unknown), dan known, msd/20 (zeros when unknown), msd known,
    rate - 1. dan is per beat (B,T) or per window (B,); dan_known, msd_known, rate (B,), msd (B,8)."""
    dk = dan_known.float()
    mk = msd_known.float()
    m = msd.float() / MSD_SCALE * mk[:, None]
    r = rate.float() - 1
    if dan.dim() == 2:
        B, T = dan.shape
        dk, mk, r = dk[:, None].expand(B, T), mk[:, None].expand(B, T), r[:, None].expand(B, T)
        m = m[:, None].expand(B, T, 8)
    four = dan_fourier(dan) * dk[..., None]
    return torch.cat([four, dk[..., None], m, mk[..., None], r[..., None]], -1)


class EncLayer(nn.Module):
    def __init__(self, d, h, ffn):
        super().__init__()
        self.h = h
        self.ln1 = nn.LayerNorm(d)
        self.qkv = nn.Linear(d, 3 * d)
        self.proj = nn.Linear(d, d)
        self.ln2 = nn.LayerNorm(d)
        self.fc1 = nn.Linear(d, ffn)
        self.fc2 = nn.Linear(ffn, d)
        self.echo_bias = nn.Parameter(torch.zeros(h))

    def forward(self, x, bias):
        B, S, d = x.shape
        h = self.h
        y = self.ln1(x)
        q, k, v = self.qkv(y).view(B, S, 3, h, d // h).permute(2, 0, 3, 1, 4)
        o = F.scaled_dot_product_attention(q, k, v, attn_mask=bias.to(q.dtype))
        x = x + self.proj(o.transpose(1, 2).reshape(B, S, d))
        return x + self.fc2(F.gelu(self.fc1(self.ln2(x)), approximate="tanh"))


class DecLayer(nn.Module):
    def __init__(self, dd, de, h, ffn):
        super().__init__()
        self.h = h
        self.ln1 = nn.LayerNorm(dd)
        self.qkv = nn.Linear(dd, 3 * dd)
        self.proj = nn.Linear(dd, dd)
        self.ln2 = nn.LayerNorm(dd)
        self.cq = nn.Linear(dd, dd)
        self.ckv = nn.Linear(de, 2 * dd)
        self.cproj = nn.Linear(dd, dd)
        self.ln3 = nn.LayerNorm(dd)
        self.fc1 = nn.Linear(dd, ffn)
        self.fc2 = nn.Linear(ffn, dd)

    def forward(self, u, enc, self_bias, cross_bias):
        B, T, dd = u.shape
        h = self.h
        y = self.ln1(u)
        q, k, v = self.qkv(y).view(B, T, 3, h, dd // h).permute(2, 0, 3, 1, 4)
        o = F.scaled_dot_product_attention(q, k, v, attn_mask=self_bias.to(q.dtype))
        u = u + self.proj(o.transpose(1, 2).reshape(B, T, dd))
        q = self.cq(self.ln2(u)).view(B, T, h, dd // h).transpose(1, 2)
        k, v = self.ckv(enc).view(B, T, 2, h, dd // h).permute(2, 0, 3, 1, 4)
        o = F.scaled_dot_product_attention(q, k, v, attn_mask=cross_bias.to(q.dtype))
        u = u + self.cproj(o.transpose(1, 2).reshape(B, T, dd))
        return u + self.fc2(F.gelu(self.fc1(self.ln3(u)), approximate="tanh"))


def mirror_masks(m: torch.Tensor) -> torch.Tensor:
    """Column c -> 3 - c (bit reversal of a 4-bit mask)."""
    return ((m & 1) << 3) | ((m & 2) << 1) | ((m & 4) >> 1) | ((m & 8) >> 3)


def history_features(ctx_rows, present, pos, pre_mask, pre_pos):
    """Per slot: the 4 most recent rows strictly before it (newest first), each as one-hot mask (16) + gap in beats
    clipped to 4 and divided by 4; a missing row is all zeros with gap 1. ctx_rows/present/pos (B,T,8);
    pre_mask/pre_pos (B,4): the last rows before the window (mask 0 = none). -> (B,T,8,68)."""
    B, T, L = ctx_rows.shape
    dev = ctx_rows.device
    m = torch.cat([pre_mask.long(), ctx_rows.reshape(B, T * L).long()], 1)
    p = torch.cat([pre_pos.float(), pos.reshape(B, T * L).float()], 1)
    isrow = torch.cat([pre_mask > 0, ((ctx_rows > 0) & present).reshape(B, T * L)], 1)
    n = m.shape[1]
    ir = isrow.long()
    c = torch.cumsum(ir, 1) - ir  # rows strictly before each position
    idx = torch.full((B, n + 1), n - 1, dtype=torch.long, device=dev)
    tgt = torch.where(isrow, c, torch.full_like(c, n))
    idx.scatter_(1, tgt, torch.arange(n, device=dev).expand(B, n).contiguous())
    ks = torch.arange(1, N_HIST + 1, device=dev)
    r = c[:, :, None] - ks  # (B,n,4)
    ok = r >= 0
    j = torch.gather(idx, 1, r.clamp(min=0).reshape(B, -1)).view(B, n, N_HIST).clamp(max=n - 1)
    hm = torch.gather(m, 1, j.reshape(B, -1)).view(B, n, N_HIST)
    hp = torch.gather(p, 1, j.reshape(B, -1)).view(B, n, N_HIST)
    gap = torch.where(ok, (p[:, :, None] - hp).clamp(max=GAP_CLIP_BEATS) / GAP_CLIP_BEATS, torch.ones_like(hp))
    onehot = F.one_hot(hm.clamp(0, 15), N_CLASSES).float() * ok[..., None].float()
    feat = torch.cat([onehot, gap[..., None]], -1)  # (B,n,4,17)
    return feat[:, N_HIST:].reshape(B, T, L, N_HIST * HIST_DIM)


class InfillModel(nn.Module):
    def __init__(self, cfg: Cfg):
        super().__init__()
        self.cfg = cfg
        d, dd = cfg.d, cfg.dec_d
        self.register_buffer("in_mean", torch.zeros(IN_DIM))
        self.register_buffer("in_inv", torch.ones(IN_DIM))
        self.in_proj = nn.Linear(IN_DIM, d)
        self.mask_emb = nn.Embedding(N_CLASSES, d)
        self.free_emb = nn.Parameter(torch.zeros(d))
        self.lane_emb = nn.Embedding(N_LANES, d)
        self.cond_proj = nn.Linear(COND_DIM, d)
        self.fam_emb = nn.Embedding(N_FAM, d)
        self.style_emb = nn.Embedding(cfg.n_styles, d)
        self.source_emb = nn.Embedding(cfg.n_sources, d)
        self.glob_emb = nn.Parameter(torch.zeros(cfg.n_glob, d))
        self.enc = nn.ModuleList([EncLayer(d, cfg.enc_heads, cfg.enc_ffn) for _ in range(cfg.enc_layers)])
        self.enc_ln = nn.LayerNorm(d)
        self.e2d = nn.Linear(d, dd)
        self.dec_mask_emb = nn.Embedding(N_CLASSES, dd)
        self.dec_lane_emb = nn.Embedding(N_LANES, dd)
        self.bos = nn.Parameter(torch.zeros(dd))
        self.dec = nn.ModuleList([DecLayer(dd, d, cfg.dec_heads, cfg.dec_ffn) for _ in range(cfg.dec_layers)])
        self.dec_ln = nn.LayerNorm(dd)
        self.head_lane_emb = nn.Embedding(N_LANES, cfg.lane_emb)
        head_in = dd + cfg.lane_emb + N_HIST * HIST_DIM + N_LANE_VALUES
        self.head1 = nn.Linear(head_in, cfg.lane_hidden)
        self.head2 = nn.Linear(cfg.lane_hidden, cfg.lane_hidden)
        self.head3 = nn.Linear(cfg.lane_hidden, N_CLASSES)
        # training-only auxiliary heads (not exported)
        self.aux_fam = nn.Linear(d, N_FAM)
        self.aux_notes = nn.Linear(d, 1)
        self.register_buffer("enc_slopes", alibi_slopes(cfg.enc_heads))
        self.register_buffer("dec_slopes", alibi_slopes(cfg.dec_heads))
        self.reset_parameters()

    def reset_parameters(self):
        for mod in self.modules():
            if isinstance(mod, nn.Linear):
                nn.init.normal_(mod.weight, std=0.02)
                nn.init.zeros_(mod.bias)
            elif isinstance(mod, nn.Embedding):
                nn.init.normal_(mod.weight, std=0.02)
        nn.init.normal_(self.free_emb, std=0.02)
        nn.init.normal_(self.glob_emb, std=0.02)
        nn.init.normal_(self.bos, std=0.02)
        for layer in self.enc:  # residual branches start small
            nn.init.normal_(layer.proj.weight, std=0.02 / math.sqrt(2 * len(self.enc)))
            nn.init.normal_(layer.fc2.weight, std=0.02 / math.sqrt(2 * len(self.enc)))

    def n_params(self, exported_only=True):
        return sum(p.numel() for n, p in self.named_parameters() if not (exported_only and n.startswith("aux_")))

    # ---- attention biases ----
    def encoder_bias(self, valid, echo):
        """valid (B,T) bool, echo (B,T,2) long (-1 = none) -> (common (B,H,S,S), echo_cells (B,1,S,S)), S = T + n_glob."""
        cfg = self.cfg
        B, T = valid.shape
        G = cfg.n_glob
        S = T + G
        dev = valid.device
        neg = float("-inf")
        t = torch.arange(T, device=dev)
        dist = (t[:, None] - t[None, :]).abs().float()
        local = dist <= cfg.win
        slopes = self.enc_slopes.to(dev)
        alibi = -slopes[:, None, None] * dist[None]  # (H,T,T)
        bb = torch.where(local[None, None] & valid[:, None, None, :], alibi[None], torch.full((1, 1, 1, 1), neg, device=dev))
        eye = torch.eye(T, dtype=torch.bool, device=dev)
        bb = torch.where((eye[None] & ~valid[:, :, None])[:, None], torch.zeros((), device=dev), bb)  # padding queries see themselves
        common = torch.full((B, cfg.enc_heads, S, S), 0.0, device=dev)
        common[:, :, :T, :T] = bb
        common[:, :, T:, :T] = torch.where(valid[:, None, None, :], 0.0, neg).expand(B, cfg.enc_heads, G, T)
        # echo cells: beat q -> beat e (outside the local window, inside the window of valid beats)
        cells = torch.zeros((B, 1, S, S), dtype=torch.bool, device=dev)
        for k in range(echo.shape[-1]):
            e = echo[:, :, k]
            ok = (e >= 0) & (e < T) & valid
            ec = e.clamp(0, T - 1)
            ok = ok & torch.gather(valid, 1, ec) & ((ec - t[None]).abs() > cfg.win)
            bi, qi = ok.nonzero(as_tuple=True)
            cells[bi, 0, qi, ec[bi, qi]] = True
        return common, cells

    def decoder_biases(self, valid):
        cfg = self.cfg
        B, T = valid.shape
        dev = valid.device
        neg = float("-inf")
        t = torch.arange(T, device=dev)
        diff = (t[:, None] - t[None, :]).float()  # q - k
        slopes = self.dec_slopes.to(dev)
        causal = (diff >= 0) & (diff < cfg.dec_win)
        self_bias = torch.where(causal[None], -slopes[:, None, None] * diff[None], torch.full((1, 1, 1), neg, device=dev))[None]
        dist = diff.abs()
        near = dist <= cfg.cross_win
        cross = torch.where(near[None, None] & valid[:, None, None, :], (-slopes[:, None, None] * dist[None])[None],
                            torch.full((1, 1, 1, 1), neg, device=dev))
        eye = torch.eye(T, dtype=torch.bool, device=dev)
        cross = torch.where((eye[None] & ~valid[:, :, None])[:, None], torch.zeros((), device=dev), cross)
        return self_bias, cross

    # ---- pieces ----
    def normalized(self, x):
        return (x.float() - self.in_mean) * self.in_inv

    def encode(self, batch):
        cfg = self.cfg
        x = self.normalized(batch["x"])
        B, T, _ = x.shape
        h = self.in_proj(x)
        rows = batch["rows"].long()
        present = batch["present"]
        visible = batch["visible"]
        lanes = self.lane_emb.weight[None, None]  # (1,1,8,d)
        vis = torch.where(visible[..., None], self.mask_emb(rows.clamp(0, 15)), self.free_emb.expand(B, T, N_LANES, -1))
        h = h + ((vis + lanes) * present[..., None].float()).sum(2)
        dan = batch["dan"].float()
        c = cond_vector(dan, batch["dan_known"], batch["msd"], batch["msd_known"], batch["rate"])
        style = self.style_emb(batch["style"].long())  # (B,d)
        source = self.source_emb(batch["source"].long())
        h = h + self.cond_proj(c) + self.fam_emb(batch["fam"].long()) + style[:, None] + source[:, None]
        valid = batch["valid"]
        vf = valid.float()
        dan_mean = (dan * vf).sum(1) / vf.sum(1).clamp(min=1)
        cg = cond_vector(dan_mean, batch["dan_known"], batch["msd"], batch["msd_known"], batch["rate"])
        g = self.glob_emb[None] + (self.cond_proj(cg) + style + source)[:, None]
        seq = torch.cat([h, g], 1)
        common, cells = self.encoder_bias(valid, batch["echo"].long())
        for layer in self.enc:
            bias = torch.where(cells, layer.echo_bias.view(1, -1, 1, 1).to(common.dtype), common)
            seq = layer(seq, bias)
        return self.enc_ln(seq[:, :T]), x

    def rows_embedding(self, rows, present):
        """(B,T,8) rows of a beat -> (B,T,dd): the sum over present lanes of mask + lane embeddings."""
        e = self.dec_mask_emb(rows.long().clamp(0, 15)) + self.dec_lane_emb.weight[None, None]
        return (e * present[..., None].float()).sum(2)

    def decode(self, batch, enc, ctx_rows):
        B, T, _ = enc.shape
        emb = self.rows_embedding(ctx_rows, batch["present"])
        first = torch.where(batch["has_prev"][:, None], self.rows_embedding(batch["prev_rows"][:, None], batch["prev_present"][:, None])[:, 0],
                            self.bos.expand(B, -1))
        prev = torch.cat([first[:, None], emb[:, :-1]], 1)
        u = self.e2d(enc) + prev
        self_bias, cross_bias = self.decoder_biases(batch["valid"])
        for layer in self.dec:
            u = layer(u, enc, self_bias, cross_bias)
        return self.dec_ln(u)

    def lane_logits(self, z, xn, hist):
        B, T, dd = z.shape
        lanes = xn[:, :, : N_LANES * N_LANE_VALUES].reshape(B, T, N_LANES, N_LANE_VALUES)
        inp = torch.cat([z[:, :, None].expand(B, T, N_LANES, dd), self.head_lane_emb.weight[None, None].expand(B, T, N_LANES, -1),
                         hist, lanes], -1)
        y = F.gelu(self.head1(inp), approximate="tanh")
        y = F.gelu(self.head2(y), approximate="tanh")
        return self.head3(y)

    def forward(self, batch, ctx_rows=None):
        """Teacher-forced forward over a batch of windows. ctx_rows: the rows the decoder and the lane history see
        (default: the true rows; scheduled sampling passes a mix). -> logits (B,T,8,16), aux heads."""
        if ctx_rows is None:
            ctx_rows = batch["rows"]
        enc, xn = self.encode(batch)
        z = self.decode(batch, enc, ctx_rows)
        hist = history_features(ctx_rows, batch["present"], batch["pos"], batch["pre_mask"], batch["pre_pos"])
        logits = self.lane_logits(z, xn, hist)
        return {"logits": logits, "fam": self.aux_fam(enc), "notes": self.aux_notes(enc)[..., 0]}


def build_model(size: str = "S", **over) -> InfillModel:
    return InfillModel(Cfg.preset(size, **over))
