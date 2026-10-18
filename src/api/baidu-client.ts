import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { RemoteFileInfo } from "../types";
import { calculateBlockList, calculateMd5 } from "../utils/crypto";

export interface BaiduTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

export class BaiduClient {
  private appKey: string;
  private secretKey: string;
  private accessToken: string;
  private refreshToken: string;
  private tokenExpiresAt: number;
  private onTokenRefreshed?: (newToken: BaiduTokenResponse) => Promise<void>;

  constructor(options: {
    appKey: string;
    secretKey: string;
    accessToken: string;
    refreshToken: string;
    tokenExpiresAt: number;
    onTokenRefreshed?: (newToken: BaiduTokenResponse) => Promise<void>;
  }) {
    this.appKey = options.appKey;
    this.secretKey = options.secretKey;
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.tokenExpiresAt = options.tokenExpiresAt;
    this.onTokenRefreshed = options.onTokenRefreshed;
  }

  public updateCredentials(
    accessToken: string,
    refreshToken: string,
    tokenExpiresAt: number
  ) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.tokenExpiresAt = tokenExpiresAt;
  }

  /**
   * Build OAuth authorization URL for user consent
   */
  public static getAuthUrl(appKey: string, redirectUri: string = "oob"): string {
    const base = "https://openapi.baidu.com/oauth/2.0/authorize";
    const params = new URLSearchParams({
      response_type: "code",
      client_id: appKey,
      redirect_uri: redirectUri,
      scope: "basic,netdisk",
      display: "page",
    });
    return `${base}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access and refresh tokens
   */
  public static async exchangeCodeForToken(
    code: string,
    appKey: string,
    secretKey: string,
    redirectUri: string = "oob"
  ): Promise<BaiduTokenResponse> {
    const url = "https://openapi.baidu.com/oauth/2.0/token";
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: code.trim(),
      client_id: appKey.trim(),
      client_secret: secretKey.trim(),
      redirect_uri: redirectUri.trim(),
    });

    const res = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const data = res.json;
    if (data.error) {
      throw new Error(`Baidu Auth Error: ${data.error_description || data.error}`);
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      scope: data.scope,
    };
  }

  /**
   * Refresh access token before expiration
   */
  private async ensureFreshToken(): Promise<string> {
    // If token expires within 5 minutes, refresh
    const now = Date.now();
    if (this.refreshToken && this.tokenExpiresAt && this.tokenExpiresAt - now < 300000) {
      try {
        const url = "https://openapi.baidu.com/oauth/2.0/token";
        const body = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: this.refreshToken,
          client_id: this.appKey,
          client_secret: this.secretKey,
        });

        const res = await requestUrl({
          url,
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        });

        const data = res.json;
        if (!data.error && data.access_token) {
          this.accessToken = data.access_token;
          this.refreshToken = data.refresh_token || this.refreshToken;
          this.tokenExpiresAt = Date.now() + (data.expires_in || 2592000) * 1000;
          if (this.onTokenRefreshed) {
            await this.onTokenRefreshed({
              access_token: this.accessToken,
              refresh_token: this.refreshToken,
              expires_in: data.expires_in || 2592000,
              scope: data.scope || "",
            });
          }
        }
      } catch (err) {
        console.warn("Failed refreshing Baidu access token:", err);
      }
    }
    return this.accessToken;
  }

  /**
   * Get user info from Baidu Netdisk (test connectivity)
   */
  public async getUserInfo(): Promise<{ baiduName: string; netdiskName: string; avatarUrl: string }> {
    const token = await this.ensureFreshToken();
    const url = `https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&access_token=${token}`;
    
    const res = await requestUrl({
      url,
      method: "GET",
    });

    const data = res.json;
    if (data.errno !== 0) {
      throw new Error(`Failed to fetch user info: errno ${data.errno}`);
    }

    return {
      baiduName: data.baidu_name || "",
      netdiskName: data.netdisk_name || "",
      avatarUrl: data.avatar_url || "",
    };
  }

  /**
   * List files under remote directory (supports recursion and pagination)
   */
  public async listFiles(dirPath: string, recursion: boolean = true): Promise<RemoteFileInfo[]> {
    const token = await this.ensureFreshToken();
    const result: RemoteFileInfo[] = [];
    let start = 0;
    const limit = 1000;
    let hasMore = true;

    while (hasMore) {
      const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=list&dir=${encodeURIComponent(
        dirPath
      )}&recursion=${recursion ? 1 : 0}&start=${start}&limit=${limit}&web=1&access_token=${token}`;

      const res = await requestUrl({
        url,
        method: "GET",
      });

      const data = res.json;
      if (data.errno === -9) {
        // Directory does not exist yet
        return [];
      }
      if (data.errno !== 0) {
        throw new Error(`Baidu list error (errno: ${data.errno}) for dir "${dirPath}"`);
      }

      if (Array.isArray(data.list)) {
        for (const item of data.list) {
          result.push({
            fsId: String(item.fs_id),
            path: item.path,
            serverFilename: item.server_filename,
            size: Number(item.size || 0),
            md5: item.md5 ? String(item.md5).toLowerCase() : undefined,
            serverMtime: Number(item.server_mtime || 0) * 1000, // convert sec to ms
            isdir: Number(item.isdir || 0),
          });
        }
      }

      if (data.has_more === 1 && data.list && data.list.length > 0) {
        start += data.list.length;
      } else {
        hasMore = false;
      }
    }

    return result;
  }

  /**
   * Get direct download link (dlink) for a given fs_id
   */
  public async getDownloadLink(fsId: string): Promise<string> {
    const token = await this.ensureFreshToken();
    const url = `https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&fsids=[${fsId}]&dlink=1&access_token=${token}`;

    const res = await requestUrl({
      url,
      method: "GET",
    });

    const data = res.json;
    if (data.errno !== 0 || !data.list || !data.list[0] || !data.list[0].dlink) {
      throw new Error(`Failed to get dlink for fs_id ${fsId} (errno: ${data?.errno})`);
    }

    return data.list[0].dlink;
  }

  /**
   * Download file content as ArrayBuffer with proper User-Agent
   */
  public async downloadFile(fsId: string): Promise<ArrayBuffer> {
    const token = await this.ensureFreshToken();
    const dlink = await this.getDownloadLink(fsId);
    
    // Baidu requires appending access_token to dlink and setting User-Agent: pan.baidu.com
    const downloadUrl = dlink.includes("?")
      ? `${dlink}&access_token=${token}`
      : `${dlink}?access_token=${token}`;

    const res = await requestUrl({
      url: downloadUrl,
      method: "GET",
      headers: {
        "User-Agent": "pan.baidu.com",
      },
    });

    return res.arrayBuffer;
  }

  /**
   * Ensure remote directory exists
   */
  public async createDirectory(remotePath: string): Promise<void> {
    const token = await this.ensureFreshToken();
    const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token=${token}`;
    
    const body = new URLSearchParams({
      path: remotePath,
      size: "0",
      isdir: "1",
      rtype: "0", // 0: return error if exists; 1: rename; 2: overwrite
    });

    try {
      const res = await requestUrl({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      const data = res.json;
      // errno -8 means file/dir already exists, which is acceptable
      if (data.errno !== 0 && data.errno !== -8) {
        console.warn(`Create dir "${remotePath}" returned errno ${data.errno}`);
      }
    } catch (e) {
      console.warn(`Error creating remote directory "${remotePath}":`, e);
    }
  }

  /**
   * Delete remote file or folder
   */
  public async deleteFile(remotePath: string): Promise<void> {
    const token = await this.ensureFreshToken();
    const url = `https://pan.baidu.com/rest/2.0/xpan/file?method=filemanager&opera=delete&access_token=${token}`;
    
    const body = new URLSearchParams({
      async: "0",
      filelist: JSON.stringify([remotePath]),
    });

    const res = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const data = res.json;
    if (data.errno !== 0 && data.errno !== -9) { // -9 means file does not exist
      throw new Error(`Failed to delete remote file "${remotePath}" (errno: ${data.errno})`);
    }
  }

  /**
   * Upload file to Baidu Netdisk using 2-phase atomic commit
   * (Precreate -> upload parts -> create commit)
   */
  public async uploadFile(
    remotePath: string,
    fileBuffer: ArrayBuffer | Uint8Array
  ): Promise<{ fsId: string; md5: string }> {
    const token = await this.ensureFreshToken();
    const bytes =
      fileBuffer instanceof Uint8Array
        ? fileBuffer
        : new Uint8Array(fileBuffer);
    const { blockList, chunks } = calculateBlockList(bytes);
    const blockListJson = JSON.stringify(blockList);

    // Phase 1: Precreate
    const precreateUrl = `https://pan.baidu.com/rest/2.0/xpan/file?method=precreate&access_token=${token}`;
    const precreateBody = new URLSearchParams({
      path: remotePath,
      size: String(bytes.length),
      isdir: "0",
      autoinit: "1",
      rtype: "3", // Overwrite on conflict
      block_list: blockListJson,
    });

    const precreateRes = await requestUrl({
      url: precreateUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: precreateBody.toString(),
    });

    const precreateData = precreateRes.json;
    if (precreateData.errno !== 0) {
      throw new Error(
        `Precreate failed for "${remotePath}" (errno: ${precreateData.errno}, msg: ${precreateData.show_msg || ""})`
      );
    }

    const uploadid = precreateData.uploadid;

    // Phase 2: Upload chunks if not rapid-uploaded (return_type 1 means rapid upload hit)
    if (precreateData.return_type !== 1 && chunks.length > 0) {
      for (let partseq = 0; partseq < chunks.length; partseq++) {
        const chunk = chunks[partseq];
        await this.uploadChunk(remotePath, uploadid, partseq, chunk);
      }
    }

    // Phase 3: Create (atomic final commit)
    const createUrl = `https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token=${token}`;
    const createBody = new URLSearchParams({
      path: remotePath,
      size: String(bytes.length),
      isdir: "0",
      rtype: "3",
      uploadid: uploadid,
      block_list: blockListJson,
    });

    const createRes = await requestUrl({
      url: createUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: createBody.toString(),
    });

    const createData = createRes.json;
    if (createData.errno !== 0) {
      throw new Error(
        `Atomic commit (create) failed for "${remotePath}" (errno: ${createData.errno})`
      );
    }

    return {
      fsId: String(createData.fs_id),
      md5: createData.md5 || calculateMd5(bytes),
    };
  }

  /**
   * Upload single block using PCS superfile2 multipart/form-data
   * Cross-platform without Buffer dependency.
   */
  private async uploadChunk(
    remotePath: string,
    uploadid: string,
    partseq: number,
    chunkBytes: Uint8Array
  ): Promise<void> {
    const token = await this.ensureFreshToken();
    const url = `https://pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload&type=tmpfile&path=${encodeURIComponent(
      remotePath
    )}&uploadid=${uploadid}&partseq=${partseq}&access_token=${token}`;

    const boundary = "----BaiduNetdiskFormBoundary" + Math.random().toString(36).substring(2);
    
    // Construct multipart payload using TextEncoder and Uint8Array
    const encoder = new TextEncoder();
    const prefix = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk_${partseq}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
    
    const totalLength = prefix.length + chunkBytes.length + suffix.length;
    const multipartBody = new Uint8Array(totalLength);
    multipartBody.set(prefix, 0);
    multipartBody.set(chunkBytes, prefix.length);
    multipartBody.set(suffix, prefix.length + chunkBytes.length);

    const res = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(multipartBody.length),
      },
      body: multipartBody.buffer.slice(
        multipartBody.byteOffset,
        multipartBody.byteOffset + multipartBody.byteLength
      ),
    });

    const data = res.json;
    if (data.errno && data.errno !== 0) {
      throw new Error(`Upload chunk ${partseq} failed (errno: ${data.errno})`);
    }
  }
}
