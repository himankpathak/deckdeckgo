import {firebase} from '@firebase/app';
import '@firebase/storage';
import {Reference, ListResult, ListOptions} from '@firebase/storage-types';

import {take} from 'rxjs/operators';

import {AuthUser} from '../../models/auth/auth.user';

import {ErrorService} from '../core/error/error.service';
import {AuthService} from '../auth/auth.service';

export class StorageService {

    private static instance: StorageService;

    private authService: AuthService;
    private errorService: ErrorService;

    maxQueryResults: number = 20;

    private constructor() {
        // Private constructor, singleton
        this.errorService = ErrorService.getInstance();
        this.authService = AuthService.getInstance();
    }

    static getInstance() {
        if (!StorageService.instance) {
            StorageService.instance = new StorageService();
        }
        return StorageService.instance;
    }

    uploadImage(image: File, folder: string, maxSize: number): Promise<StorageFile> {
        return new Promise<StorageFile>((resolve) => {
            try {
                this.authService.watch().pipe(take(1)).subscribe(async (authUser: AuthUser) => {
                    if (!authUser || !authUser.uid || authUser.uid === '' || authUser.uid === undefined) {
                        this.errorService.error('Not logged in.');
                        resolve();
                        return;
                    }

                    if (!image || !image.name) {
                        this.errorService.error('Image not valid.');
                        resolve();
                        return;
                    }

                    if (image.size > 10485760) {
                        this.errorService.error(`Image is too big (max. ${maxSize / 1048576} Mb)`);
                        resolve();
                        return;
                    }

                    const ref: Reference = firebase.storage().ref(`${authUser.uid}/assets/${folder}/${image.name}`);

                    await ref.put(image);

                    resolve({
                        downloadUrl: await ref.getDownloadURL(),
                        fullPath: ref.fullPath
                    });
                });
            } catch (err) {
                this.errorService.error(err.message);
                resolve();
            }
        });
    }

    getImages(next: string | null): Promise<StorageFilesList | null> {
        return new Promise<StorageFilesList | null>((resolve) => {
            try {
                this.authService.watch().pipe(take(1)).subscribe(async (authUser: AuthUser) => {
                    if (!authUser || !authUser.uid || authUser.uid === '' || authUser.uid === undefined) {
                        this.errorService.error('Not logged in.');
                        resolve(null);
                        return;
                    }

                    const ref = firebase.storage().ref(`${authUser.uid}/assets/images/`);

                    let options: ListOptions = {
                        maxResults: this.maxQueryResults
                    };

                    if (next) {
                        options.pageToken = next
                    }

                    const results: ListResult = await ref.list(options);

                    resolve(this.toStorageFileList(results));
                });
            } catch (err) {
                resolve(null);
            }
        })
    }

    private toStorageFileList(results: ListResult): Promise<StorageFilesList> {
        return new Promise<StorageFilesList>(async (resolve) => {
            if (!results || !results.items || results.items.length <= 0) {
                resolve({
                    items: [],
                    nextPageToken: null
                });
                return;
            }

            const storageFiles: Promise<StorageFile>[] = results.items.map(this.toStorageFile);
            const items: StorageFile[] = await Promise.all(storageFiles);

            resolve({
                items: items,
                nextPageToken: results.nextPageToken
            });
        });
    }

    private toStorageFile(ref: Reference): Promise<StorageFile> {
        return new Promise<StorageFile>(async (resolve) => {
            resolve({
                downloadUrl: await ref.getDownloadURL(),
                fullPath: ref.fullPath
            });
        });
    }

}
