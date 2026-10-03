
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const uploadsDir = '/var/www/connect-bharat/Backend/uploads';

async function processDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      await processDir(fullPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();

      if (['.jpg', '.jpeg', '.png'].includes(ext)) {
        const baseName = path.basename(entry.name, ext);
        const webpPath = path.join(dir, `${baseName}.webp`);

        try {
          const originalSize = fs.statSync(fullPath).size;
          await sharp(fullPath)
            .webp({ quality: 82, effort: 4 })
            .toFile(webpPath);
          const newSize = fs.statSync(webpPath).size;
          const reduction = (((originalSize - newSize) / originalSize) * 100).toFixed(1);
          console.log(`Converted: ${entry.name} (${originalSize}B -> ${newSize}B, ${reduction}% smaller)`);
        } catch (err) {
          console.error(`Failed converting ${entry.name}: ${err.message}`);
        }
      }
    }
  }
}

console.log('Starting WebP conversion for all existing upload images...');
await processDir(uploadsDir);
console.log('All images converted to WebP successfully!');
