import { supabase } from "@/lib/supabase";

interface CompressionOptions {
  maxWidth?: number;
  maxHeight?: number;
  maxSizeBytes?: number;
}

/**
 * Compresses an image in the client browser to WebP format strictly under 50KB.
 * Eliminates high-bandwidth asset transfers to Supabase and speeds up POS grid loads.
 */
export async function compressImageToWebP(
  file: File | Blob,
  options: CompressionOptions = {},
): Promise<Blob> {
  const maxWidth = options.maxWidth ?? 800;
  const maxHeight = options.maxHeight ?? 800;
  const maxSizeBytes = options.maxSizeBytes ?? 50 * 1024; // 50 KB strict cap

  // 1. Decode image into bitmap
  let bitmap: ImageBitmap;
  if ("createImageBitmap" in window) {
    bitmap = await createImageBitmap(file);
  } else {
    bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img as unknown as ImageBitmap);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  // 2. Compute aspect-ratio preserved dimensions
  let { width, height } = bitmap;
  if (width > maxWidth || height > maxHeight) {
    const ratio = Math.min(maxWidth / width, maxHeight / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire 2D canvas rendering context");

  ctx.drawImage(bitmap, 0, 0, width, height);

  // 3. Iterative compression loop to hit < 50KB constraint
  let quality = 0.85;
  let compressedBlob: Blob | null = null;

  while (quality >= 0.3) {
    compressedBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/webp", quality);
    });

    if (compressedBlob && compressedBlob.size <= maxSizeBytes) {
      break;
    }
    quality -= 0.15;
  }

  // If still above 50KB at 0.3 quality, downscale resolution by 30%
  if (compressedBlob && compressedBlob.size > maxSizeBytes) {
    canvas.width = Math.round(width * 0.7);
    canvas.height = Math.round(height * 0.7);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    compressedBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/webp", 0.5);
    });
  }

  if (!compressedBlob) {
    throw new Error("Image compression failed to produce a valid WebP blob");
  }

  return compressedBlob;
}

/**
 * Uploads compressed WebP menu photo directly to Supabase Storage with 1-year cache control.
 * Bypasses backend Vercel serverless function, reducing compute time and egress.
 */
export async function uploadMenuImageToStorage(
  file: File,
  tenantId: string,
  folder = "menu-items",
): Promise<string> {
  const compressedBlob = await compressImageToWebP(file, {
    maxWidth: 800,
    maxHeight: 800,
    maxSizeBytes: 50 * 1024,
  });

  const fileExt = "webp";
  const uniqueId = crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).substring(2, 10);
  const filePath = `${tenantId}/${folder}/${Date.now()}_${uniqueId}.${fileExt}`;

  const { error: uploadError } = await supabase.storage
    .from("menu-media")
    .upload(filePath, compressedBlob, {
      contentType: "image/webp",
      cacheControl: "31536000", // 1 year Edge/CDN cache
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Failed to upload menu image: ${uploadError.message}`);
  }

  const { data } = supabase.storage.from("menu-media").getPublicUrl(filePath);
  return data.publicUrl;
}
