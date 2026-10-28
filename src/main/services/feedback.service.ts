import { readFileSync, statSync } from 'fs';
import * as os from 'os';
import { basename } from 'path';

import { app, dialog, net } from 'electron';

import { API_BASE_URL } from '../lib/api-urls';

import { agentPresetService } from './agent-preset.service';
import { licenseService } from './license.service';

export type FeedbackType = 'bug' | 'feature' | 'general';

export interface FeedbackPayload {
  type: FeedbackType;
  description: string;
  email?: string;
  screenshotPaths?: string[];
}

export interface FeedbackResult {
  success: boolean;
  error?: string;
}

interface Screenshot {
  filename: string;
  data: string; // base64
  contentType: string;
}

// Route through server - never expose webhook URL to client
const FEEDBACK_URL = `${API_BASE_URL}/api/v1/feedback`;

class FeedbackService {
  async selectScreenshots(): Promise<string[]> {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
      title: 'Select Screenshots (up to 3)',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }

    // Limit to 3 files
    return result.filePaths.slice(0, 3);
  }

  async sendFeedback(payload: FeedbackPayload): Promise<FeedbackResult> {
    const licenseStatus = licenseService.getStatus();
    const activePreset = agentPresetService.getActive();

    // Prepare screenshots as base64
    const screenshots: Screenshot[] = [];
    if (payload.screenshotPaths) {
      for (const filePath of payload.screenshotPaths) {
        try {
          const stats = statSync(filePath);
          // Skip files larger than 8MB
          if (stats.size > 8 * 1024 * 1024) {
            continue;
          }

          const fileContent = readFileSync(filePath);
          const filename = basename(filePath);
          const ext = filename.toLowerCase().split('.').pop();

          let contentType = 'image/png';
          if (ext === 'jpg' || ext === 'jpeg') contentType = 'image/jpeg';
          else if (ext === 'gif') contentType = 'image/gif';
          else if (ext === 'webp') contentType = 'image/webp';

          screenshots.push({
            filename,
            data: fileContent.toString('base64'),
            contentType,
          });
        } catch (err) {
          console.error('Failed to read screenshot:', filePath, err);
        }
      }
    }

    // Build request body
    const body = {
      type: payload.type,
      description: payload.description,
      email: payload.email || undefined,
      screenshots: screenshots.length > 0 ? screenshots : undefined,
      systemInfo: {
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        osVersion: os.release(),
        isLicensed: licenseStatus.isLicensed && licenseStatus.licenseKey !== null,
        agentPresetName: activePreset?.name || null,
      },
    };

    return this.sendRequest(body);
  }

  private sendRequest(body: object): Promise<FeedbackResult> {
    return new Promise((resolve) => {
      try {
        const request = net.request({
          method: 'POST',
          url: FEEDBACK_URL,
        });

        request.setHeader('Content-Type', 'application/json');

        let responseBody = '';

        request.on('response', (response) => {
          response.on('data', (chunk) => {
            responseBody += chunk.toString();
          });

          response.on('end', () => {
            if (response.statusCode === 200 || response.statusCode === 204) {
              resolve({ success: true });
            } else {
              console.error('Feedback server error:', response.statusCode, responseBody);
              try {
                const errorData = JSON.parse(responseBody);
                resolve({
                  success: false,
                  error: errorData.error || `Server returned ${response.statusCode}`,
                });
              } catch {
                resolve({ success: false, error: `Server returned ${response.statusCode}` });
              }
            }
          });
        });

        request.on('error', (error) => {
          console.error('Feedback send error:', error);
          resolve({ success: false, error: 'Failed to connect to feedback server' });
        });

        request.write(JSON.stringify(body));
        request.end();
      } catch (error) {
        console.error('Feedback send error:', error);
        resolve({ success: false, error: (error as Error).message });
      }
    });
  }
}

export const feedbackService = new FeedbackService();
