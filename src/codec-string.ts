// 从 Annex-B 配置包（SPS）推导 WebCodecs codec 字符串

/** 遍历 Annex-B 码流中的 NAL 单元（不含起始码） */
export function* nalUnits(data: Uint8Array): Generator<Uint8Array> {
  let i = 0;
  let start = -1;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        if (end > start && data[end - 1] === 0) end--; // 4 字节起始码
        yield data.subarray(start, end);
      }
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < data.length) yield data.subarray(start);
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

export function h264CodecString(config: Uint8Array): string {
  for (const nal of nalUnits(config)) {
    if ((nal[0] & 0x1f) === 7 && nal.length >= 4) {
      return `avc1.${hex2(nal[1])}${hex2(nal[2])}${hex2(nal[3])}`;
    }
  }
  return 'avc1.42e01f';
}

/** 去掉防竞争字节 00 00 03 */
function unescapeRbsp(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]);
  }
  return new Uint8Array(out);
}

function reverseBits32(n: number): number {
  let r = 0;
  for (let i = 0; i < 32; i++) {
    r = (r << 1) | (n & 1);
    n >>>= 1;
  }
  return r >>> 0;
}

export function h265CodecString(config: Uint8Array): string {
  for (const nal of nalUnits(config)) {
    const type = (nal[0] >> 1) & 0x3f;
    if (type !== 33 || nal.length < 15) continue; // SPS
    const b = unescapeRbsp(nal);
    // b[0..1] NAL 头，b[2] = vps_id(4) | max_sub_layers_minus1(3) | temporal_id_nesting(1)
    // b[3..14] profile_tier_level 的 general 部分
    const ptl = b.subarray(3);
    const space = ptl[0] >> 6;
    const tier = (ptl[0] >> 5) & 1;
    const profile = ptl[0] & 0x1f;
    const compat = ((ptl[1] << 24) | (ptl[2] << 16) | (ptl[3] << 8) | ptl[4]) >>> 0;
    const constraints = Array.from(ptl.subarray(5, 11));
    const level = ptl[11];
    while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
    const parts = [
      'hvc1',
      `${['', 'A', 'B', 'C'][space]}${profile}`,
      reverseBits32(compat).toString(16),
      `${tier ? 'H' : 'L'}${level}`,
      ...constraints.map((c) => c.toString(16)),
    ];
    return parts.join('.');
  }
  return 'hvc1.1.6.L120.90';
}
