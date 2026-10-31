// The encoded polyline format (precision 5, about a metre), for the seed's committed roads: a road across the
// country in a few kilobytes of text instead of tens of kilobytes of JSON. Points are [longitude, latitude].

export function encodePolyline(points: readonly (readonly [number, number])[]): string {
  let out = '';
  let lastLat = 0;
  let lastLng = 0;
  for (const [lng, lat] of points) {
    const la = Math.round(lat * 1e5);
    const ln = Math.round(lng * 1e5);
    out += encodeValue(la - lastLat) + encodeValue(ln - lastLng);
    lastLat = la;
    lastLng = ln;
  }
  return out;
}

export function decodePolyline(text: string): [number, number][] {
  const points: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < text.length) {
    const dLat = readValue();
    const dLng = readValue();
    lat += dLat;
    lng += dLng;
    points.push([lng / 1e5, lat / 1e5]);
  }
  return points;

  function readValue(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (i >= text.length) throw new Error('Truncated polyline');
      byte = text.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  }
}

function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return out + String.fromCharCode(v + 63);
}
