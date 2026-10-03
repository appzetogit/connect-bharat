import api from '../api/axiosInstance';

export const uploadService = {
  /**
   * Upload an image (base64) to Cloudinary via the backend
   * @param {string} base64Image - The base64 string of the image
   * @param {string} folder - Destination folder on Cloudinary
   * @param {{ signupPhone?: string, registrationId?: string }} [preAuth] - For
   *   uploads before a login token exists (signup / onboarding). The backend
   *   accepts these instead of a JWT.
   * @returns {Promise<{url: string, publicId: string, format: string}>}
   */
  uploadImage: async (base64Image, folder = 'general', preAuth = {}) => {
    try {
      const headers = {};
      if (preAuth?.signupPhone) headers['X-Signup-Phone'] = String(preAuth.signupPhone);
      if (preAuth?.registrationId) headers['X-Registration-Id'] = String(preAuth.registrationId);
      const response = await api.post('/common/upload/image', {
        image: base64Image,
        folder
      }, Object.keys(headers).length ? { headers } : undefined);
      return response?.data || response;
    } catch (error) {
      console.error('Upload Service Error:', error);
      throw error;
    }
  }
};
