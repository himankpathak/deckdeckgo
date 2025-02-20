import {firebase} from '@firebase/app';
import '@firebase/firestore';

import {Observable, Subject} from 'rxjs';
import {take} from 'rxjs/operators';

import {Deck, DeckMetaAuthor} from '../../../models/data/deck';
import {ApiDeck} from '../../../models/api/api.deck';
import {Slide, SlideTemplate} from '../../../models/data/slide';
import {User} from '../../../models/data/user';

import {ApiPresentation} from '../../../models/api/api.presentation';
import {ApiSlide} from '../../../models/api/api.slide';

import {DeckService} from '../../data/deck/deck.service';
import {SlideService} from '../../data/slide/slide.service';
import {UserService} from '../../data/user/user.service';
import {DeckEditorService} from '../deck/deck-editor.service';

import {ApiPresentationService} from '../../api/presentation/api.presentation.service';
import {ApiPresentationFactoryService} from '../../api/presentation/api.presentation.factory.service';

import {EnvironmentConfigService} from '../../core/environment/environment-config.service';

export class PublishService {

    private static instance: PublishService;

    private deckEditorService: DeckEditorService;

    private apiPresentationService: ApiPresentationService;

    private deckService: DeckService;
    private slideService: SlideService;

    private userService: UserService;

    private progressSubject: Subject<number> = new Subject<number>();

    private constructor() {
        // Private constructor, singleton
        this.deckEditorService = DeckEditorService.getInstance();

        this.apiPresentationService = ApiPresentationFactoryService.getInstance();

        this.deckService = DeckService.getInstance();
        this.slideService = SlideService.getInstance();

        this.userService = UserService.getInstance();
    }

    static getInstance() {
        if (!PublishService.instance) {
            PublishService.instance = new PublishService();
        }
        return PublishService.instance;
    }

    watchProgress(): Observable<number> {
        return this.progressSubject.asObservable();
    }

    private progress(progress: number) {
        this.progressSubject.next(progress);
    }

    private progressComplete() {
        this.progressSubject.next(1);
    }

    // TODO: Move in a cloud functions?
    publish(description: string, tags: string[]): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.progress(0);

            this.deckEditorService.watch().pipe(take(1)).subscribe(async (deck: Deck) => {
                try {
                    if (!deck || !deck.id || !deck.data) {
                        this.progressComplete();
                        reject('No deck found');
                        return;
                    }

                    const apiDeck: ApiDeck = await this.convertDeck(deck, description);

                    this.progress(0.25);

                    const apiDeckPublish: ApiPresentation = await this.publishDeck(deck, apiDeck);

                    this.progress(0.50);

                    if (!apiDeckPublish || !apiDeckPublish.id || !apiDeckPublish.url) {
                        this.progressComplete();
                        reject('Publish failed');
                        return;
                    }

                    this.progress(0.75);

                    const newApiId: boolean = deck.data.api_id !== apiDeckPublish.id;
                    if (newApiId) {
                        deck.data.api_id = apiDeckPublish.id;

                        deck = await this.deckService.update(deck);
                    }

                    this.progress(0.80);

                    const publishedUrl: string = apiDeckPublish.url;

                    await this.delayUpdateMeta(deck, publishedUrl, description, tags, newApiId);

                    resolve(publishedUrl);
                } catch (err) {
                    this.progressComplete();
                    reject(err);
                }
            });
        });
    }

    private publishDeck(deck: Deck, apiDeck: ApiDeck): Promise<ApiPresentation> {
        return new Promise<ApiPresentation>(async (resolve, reject) => {
            try {
                const apiDeckPublish: ApiPresentation = await this.createOrUpdatePublish(deck, apiDeck);

                resolve(apiDeckPublish);
            } catch (err) {
                reject (err);
            }
        })
    }

    private createOrUpdatePublish(deck: Deck, apiDeck: ApiDeck): Promise<ApiPresentation> {
        if (deck.data.api_id) {
            return this.apiPresentationService.put(deck.data.api_id, apiDeck);
        } else {
            return this.apiPresentationService.post(apiDeck);
        }
    }

    private convertDeck(deck: Deck, description: string): Promise<ApiDeck> {
        return new Promise<ApiDeck>(async (resolve, reject) => {
            try {
                const apiSlides: ApiSlide[] = await this.convertSlides(deck);

                const apiDeck: ApiDeck = {
                    name: deck.data.name ? deck.data.name.trim() : deck.data.name,
                    description: description !== undefined && description !== '' ? description : deck.data.name,
                    owner_id: deck.data.owner_id,
                    attributes: deck.data.attributes,
                    background: deck.data.background,
                    slides: apiSlides
                };

                resolve(apiDeck);
            } catch (err) {
                reject(err);
            }
        });
    }

    private convertSlides(deck: Deck): Promise<ApiSlide[]> {
        return new Promise<ApiSlide[]>(async (resolve, reject) => {
            if (!deck.data.slides || deck.data.slides.length <= 0) {
                resolve([]);
                return;
            }

            try {
                const promises: Promise<ApiSlide>[] = [];

                for (let i: number = 0; i < deck.data.slides.length; i++) {
                    const slideId: string = deck.data.slides[i];

                    promises.push(this.convertSlide(deck, slideId));
                }

                if (!promises || promises.length <= 0) {
                    resolve([]);
                    return;
                }

                const slides: ApiSlide[] = await Promise.all(promises);

                resolve(slides);
            } catch (err) {
                reject(err);
            }
        });
    }

    private convertSlide(deck: Deck, slideId: string): Promise<ApiSlide> {
        return new Promise<ApiSlide>(async (resolve, reject) => {
            const slide: Slide = await this.slideService.get(deck.id, slideId);

            if (!slide || !slide.data) {
                reject('Missing slide for publishing');
                return;
            }

            const apiSlide: ApiSlide = {
                template: slide.data.template,
                content: slide.data.content,
                attributes: slide.data.attributes
            };

            const cleanApiSlide: ApiSlide = await this.convertSlideQRCode(apiSlide);

            resolve(cleanApiSlide);
        });
    }

    private convertSlideQRCode(apiSlide: ApiSlide): Promise<ApiSlide> {
        return new Promise<ApiSlide>(async (resolve) => {
            if (!apiSlide) {
                resolve(apiSlide);
                return;
            }

            if (apiSlide.template !== SlideTemplate.QRCODE) {
                resolve(apiSlide);
                return;
            }

            const presentationUrl: string = EnvironmentConfigService.getInstance().get('deckdeckgo').presentationUrl;

            // If no attributes at all, we create an attribute "content" of the QR code with it's upcoming published url
            if (!apiSlide.attributes) {
                apiSlide.attributes = {
                    content: `${presentationUrl}{{DECKDECKGO_BASE_HREF}}`
                };
            }

            // If not custom content, we replace the attribute "content" of the QR code with it's upcoming published url
            if (!apiSlide.attributes.hasOwnProperty('customQRCode') || !apiSlide.attributes.customQRCode) {
                apiSlide.attributes.content = `${presentationUrl}{{DECKDECKGO_BASE_HREF}}`;
            }

            // In any case, we don't need customQRCode attribute in our presentations, this is an attribute used by the editor
            if (apiSlide.attributes.hasOwnProperty('customQRCode')) {
                delete apiSlide.attributes['customQRCode'];
            }

            resolve(apiSlide);
        });
    }

    // Even if we fixed the delay to publish to Cloudfare CDN (#195), sometimes if too quick, the presentation will not be correctly published
    // Therefore, to avoid such problem, we add a bit of delay in the process but only for the first publish
    private delayUpdateMeta(deck: Deck, publishedUrl: string, description: string, tags: string[], delay: boolean): Promise<void> {
        return new Promise<void>((resolve) => {
            setTimeout(() => {
                this.progress(0.9);

                setTimeout(async () => {
                    await this.updateDeckMeta(deck, publishedUrl, description, tags);

                    this.progress(0.95);

                    await this.refreshDeck(deck.id);

                    this.progressComplete();

                    setTimeout(() => {
                        resolve();
                    }, 500);

                }, delay ? 3500 : 0);

            }, delay ? 3500 : 0);
        });
    }

    // Otherwise we gonna kept in memory references like firebase.firestore.FieldValue.delete instead of null values
    private refreshDeck(deckId: string): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            try {
                const freshDeck: Deck = await this.deckService.get(deckId);
                this.deckEditorService.next(freshDeck);

                resolve();
            } catch (err) {
                reject(err);
            }
        });
    }

    private updateDeckMeta(deck: Deck, publishedUrl: string, description: string, tags: string[]): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            try {
                if (!publishedUrl || publishedUrl === undefined || publishedUrl === '') {
                    resolve();
                    return;
                }

                this.userService.watch().pipe(take(1)).subscribe(async (user: User) => {
                    const url: URL = new URL(publishedUrl);
                    const now: firebase.firestore.Timestamp = firebase.firestore.Timestamp.now();

                    if (!deck.data.meta) {
                        deck.data.meta = {
                            title: deck.data.name,
                            pathname: url.pathname,
                            published: true,
                            published_at: now,
                            feed: true,
                            updated_at: now
                        };
                    } else {
                        deck.data.meta.title = deck.data.name;
                        deck.data.meta.pathname = url.pathname;
                        deck.data.meta.updated_at = now;
                    }

                    if (description && description !== undefined && description !== '') {
                        deck.data.meta.description = description;
                    } else {
                        deck.data.meta.description = firebase.firestore.FieldValue.delete();
                    }

                    if (!tags || tags.length <= 0) {
                        deck.data.meta.tags = firebase.firestore.FieldValue.delete();
                    } else {
                        deck.data.meta.tags = tags;
                    }

                    if (user && user.data && user.data.name) {
                        if (!deck.data.meta.author) {
                            deck.data.meta.author = {
                                name: user.data.name
                            };
                        } else {
                            (deck.data.meta.author as DeckMetaAuthor).name = user.data.name
                        }

                        if (user.data.photo_url) {
                            (deck.data.meta.author as DeckMetaAuthor).photo_url = user.data.photo_url;
                        }
                    } else {
                        if (deck.data.meta.author) {
                            deck.data.meta.author = firebase.firestore.FieldValue.delete();
                        }
                    }

                    await this.deckService.update(deck);

                    resolve();
                });
            } catch (err) {
                reject(err);
            }
        });
    }
}
